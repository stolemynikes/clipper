import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { count, eq } from 'drizzle-orm';
import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy';
import type { Db } from '../db/client.ts';
import { clips, jobs, moments, sources, streamers } from '../db/schema.ts';
import { paths } from '../env.ts';
import { logger, redact } from '../log.ts';
import type { Job } from '../queue/queue.ts';

const log = logger('telegram');
const pauseFile = join(paths.dataDir, 'paused');
export const isPaused = () => existsSync(pauseFile);

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const hms = (sec: number) => new Date(sec * 1000).toISOString().slice(11, 19);

/** Review caption: who, where in the VOD, why it scored. Plain HTML, scannable on a phone. */
export function reviewCaption(c: { streamer: string; url: string; startSec: number; durationSec: number; score: number; signals: Record<string, number> }) {
  const s = c.signals;
  return [
    `<b>${esc(c.streamer)}</b> · ${Math.round(c.durationSec)}s · score <b>${c.score.toFixed(1)}</b>`,
    `<a href="${esc(c.url)}?t=${Math.floor(c.startSec)}s">VOD @ ${hms(c.startSec)}</a>`,
    `chat ${(s.chatRate ?? 0).toFixed(1)} · emotes ${(s.emoteScore ?? 0).toFixed(1)} · viewer clips ${s.viewerClipHits ?? 0}`,
  ].join('\n');
}

/** Telegram rate-limits bursts (429); wait the time it asks for instead of failing the job. */
export async function withRateLimit<T>(call: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (e) {
      const wait = e instanceof GrammyError && e.error_code === 429 ? e.parameters.retry_after : undefined;
      if (wait === undefined || i >= tries) throw e;
      log.warn(`telegram 429, retrying in ${wait}s`);
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
    }
  }
}

export function createBot(db: Db) {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const chatId = process.env.TELEGRAM_CHAT_ID!;
  const bot = new Bot(token);

  // Only the owner's chat may control the bot.
  bot.use(async (ctx, next) => {
    if (String(ctx.chat?.id) === chatId) await next();
  });

  bot.command('pause', async (ctx) => {
    writeFileSync(pauseFile, new Date().toISOString());
    await ctx.reply('⏸ Paused. Running job finishes, nothing new starts. /resume to continue.');
  });
  bot.command('resume', async (ctx) => {
    rmSync(pauseFile, { force: true });
    await ctx.reply('▶️ Resumed.');
  });
  bot.command('status', async (ctx) => {
    const byStatus = db.select({ status: jobs.status, n: count() }).from(jobs).groupBy(jobs.status).all();
    const clipStats = db.select({ status: clips.status, n: count() }).from(clips).groupBy(clips.status).all();
    const fmt = (rows: { status: string; n: number }[]) => rows.map((r) => `${r.status} ${r.n}`).join(' · ') || 'none';
    await ctx.reply([`<b>Status</b> ${isPaused() ? '⏸ paused' : '▶️ running'}`, `Jobs: ${fmt(byStatus)}`, `Clips: ${fmt(clipStats)}`].join('\n'),
      { parse_mode: 'HTML' });
  });

  bot.callbackQuery(/^(approve|reject):(\d+)$/, async (ctx) => {
    const [, action, id] = ctx.match!;
    const clip = db.select().from(clips).where(eq(clips.id, Number(id))).get();
    if (!clip || clip.status !== 'pending_review') return ctx.answerCallbackQuery({ text: 'Already handled' });
    const approved = action === 'approve';
    if (approved) {
      const dir = join(paths.dataDir, 'approved');
      mkdirSync(dir, { recursive: true });
      copyFileSync(clip.filePath, join(dir, `clip-${clip.id}-${basename(clip.filePath)}`));
    }
    db.update(clips).set({ status: approved ? 'approved' : 'rejected' }).where(eq(clips.id, clip.id)).run();
    await ctx.answerCallbackQuery({ text: approved ? 'Approved' : 'Rejected' });
    await ctx.editMessageCaption({
      caption: `${ctx.callbackQuery.message?.caption ?? ''}\n\n${approved ? '✅ Approved' : '❌ Rejected'}`,
      reply_markup: undefined,
    });
  });

  bot.catch((err) => log.error('bot error', { error: redact(String(err.error)) }));

  /** Job handler: send a rendered clip for review. */
  async function sendReview({ clipId }: { clipId: number }) {
    const row = db.select({ clip: clips, moment: moments, source: sources, streamer: streamers })
      .from(clips).innerJoin(moments, eq(clips.momentId, moments.id)).innerJoin(sources, eq(moments.sourceId, sources.id))
      .innerJoin(streamers, eq(sources.streamerId, streamers.id)).where(eq(clips.id, clipId)).get();
    if (!row) throw new Error(`clip ${clipId} not found`);
    await withRateLimit(() => bot.api.sendVideo(chatId, new InputFile(row.clip.filePath), {
      caption: reviewCaption({ streamer: row.streamer.name, url: row.source.url, startSec: row.moment.startSec,
        durationSec: row.clip.durationSec ?? 0, score: row.moment.score, signals: (row.moment.signals ?? {}) as Record<string, number> }),
      parse_mode: 'HTML',
      supports_streaming: true,
      reply_markup: new InlineKeyboard().text('✅ Approve', `approve:${clipId}`).text('❌ Reject', `reject:${clipId}`),
    }));
  }

  async function alertFailure(job: Job) {
    const err = redact(job.error ?? '').split('\n').slice(0, 6).join('\n');
    await withRateLimit(() => bot.api.sendMessage(chatId, `⚠️ <b>Job failed</b> ${esc(job.type)} #${job.id} after ${job.attempts} attempts\n<pre>${esc(err)}</pre>`,
      { parse_mode: 'HTML' })).catch((e) => log.error('alert failed', { error: String(e) }));
  }

  return { bot, sendReview, alertFailure };
}
