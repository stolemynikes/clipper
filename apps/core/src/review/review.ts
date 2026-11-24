// Review flow without Telegram: Bark push to the phone, decisions on a page served over Tailscale.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { count, eq, max } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { clips, jobs, moments, sources, streamers } from '../db/schema.ts';
import { paths } from '../env.ts';
import { loadSettings, type AutoKeep } from '../config.ts';
import { logger, redact } from '../log.ts';
import type { Job } from '../queue/queue.ts';
import { queuePublish } from '../modules/publisher/publish.ts';
import { discordReview } from '../discord/bot.ts';

const log = logger('review');
const pauseFile = join(paths.dataDir, 'paused');
export const isPaused = () => existsSync(pauseFile);
export const setPaused = (on: boolean) => (on ? writeFileSync(pauseFile, new Date().toISOString()) : rmSync(pauseFile, { force: true }));
export const reviewUrl = () => process.env.REVIEW_URL || `http://localhost:${process.env.REVIEW_PORT || 8787}`;

/** Push via Bark (iOS). group "clipper" keeps these apart from other apps on the same key. */
export async function bark(title: string, body: string, o: { url?: string; copy?: string; level?: 'active' | 'timeSensitive' | 'passive' } = {}) {
  const { BARK_URL, BARK_KEY } = process.env;
  if (!BARK_URL || !BARK_KEY) throw new Error('BARK_URL or BARK_KEY missing in .env');
  const q = new URLSearchParams({ group: 'clipper', sound: 'glass', level: o.level ?? 'active', ...(o.url && { url: o.url }), ...(o.copy && { copy: o.copy, autoCopy: '1' }) });
  const res = await fetch(`${BARK_URL}/${BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${q}`);
  if (!res.ok) throw new Error(`bark push failed: HTTP ${res.status}`); // never include the URL: it holds the key
}

const clipRows = (db: Db) => db.select({ clip: clips, moment: moments, source: sources, streamer: streamers })
  .from(clips).innerJoin(moments, eq(clips.momentId, moments.id)).innerJoin(sources, eq(moments.sourceId, sources.id))
  .innerJoin(streamers, eq(sources.streamerId, streamers.id));

export type ReviewRow = ReturnType<typeof pendingClips>[number];
export const pendingClips = (db: Db) => clipRows(db).where(eq(clips.status, 'pending_review')).all();
/** Strength 1-10, relative to the best moment of the same stream (raw scores have no upper bound). */
export const rating = (score: number, best: number) => (best > 0 ? Math.max(1, Math.min(10, Math.round((score / best) * 10))) : 5);
export const bestScores = (db: Db) =>
  new Map(db.select({ id: moments.sourceId, best: max(moments.score) }).from(moments).groupBy(moments.sourceId).all().map((r) => [r.id, r.best ?? 0]));
export const getClip = (db: Db, id: number) => db.select().from(clips).where(eq(clips.id, id)).get();

export function status(db: Db) {
  return {
    paused: isPaused(),
    jobs: db.select({ status: jobs.status, n: count() }).from(jobs).groupBy(jobs.status).all(),
    clips: db.select({ status: clips.status, n: count() }).from(clips).groupBy(clips.status).all(),
  };
}

/** Approve (copy to data/approved) or reject. False if the clip is unknown or already handled. */
export function decide(db: Db, id: number, approved: boolean): boolean {
  const clip = getClip(db, id);
  if (!clip || clip.status !== 'pending_review') return false;
  if (approved) {
    const dir = join(paths.dataDir, 'approved');
    mkdirSync(dir, { recursive: true });
    copyFileSync(clip.filePath, join(dir, `clip-${clip.id}-${basename(clip.filePath)}`));
  }
  db.update(clips).set({ status: approved ? 'approved' : 'rejected' }).where(eq(clips.id, id)).run();
  if (approved) queuePublish(db, id);
  return true;
}

/** Auto-keep only on human signals (viewer clips + chat), never on loudness, and only with a clean compliance check. */
export function autoKeep(signals: Record<string, number>, warnings: string[], cfg: AutoKeep | undefined): boolean {
  if (!cfg?.enabled || warnings.length) return false;
  return (signals.viewerClipHits ?? 0) >= cfg.minViewerClips && (signals.chatRate ?? 0) >= cfg.minChatRate && !signals.website;
}

/** Job handler: tell the phone a clip waits for review; the tap opens the review page at that clip. */
export async function notifyReview(db: Db, { clipId }: { clipId: number }) {
  const row = clipRows(db).where(eq(clips.id, clipId)).get();
  if (!row) throw new Error(`clip ${clipId} not found`);
  if (row.clip.status !== 'pending_review') return;
  const warnings = (row.clip.compliance?.warnings ?? []) as string[];
  const review = { clipId, streamer: row.streamer.name, file: row.clip.filePath, title: row.clip.title, hook: row.clip.hook, seconds: row.clip.durationSec ?? 0, signals: (row.moment.signals ?? {}) as Record<string, number>, warnings,
    rating: rating(row.moment.score, bestScores(db).get(row.moment.sourceId) ?? 0) };
  if (autoKeep((row.moment.signals ?? {}) as Record<string, number>, warnings, loadSettings().review?.autoKeep) && decide(db, clipId, true)) {
    log.info(`clip ${clipId} auto-kept`);
    // Mark it, so the learner never treats its own decision as the owner's (no circular learning).
    db.update(moments).set({ signals: { ...(row.moment.signals ?? {}), autoKept: 1 } }).where(eq(moments.id, row.moment.id)).run();
    if (await discordReview({ ...review, autoKept: true })) return;
    return bark(`Auto-kept · ${row.streamer.name}`, 'Viewers clipped it and chat reacted. Tap to watch.', { url: `${reviewUrl()}/#clip-${clipId}`, level: 'passive' });
  }
  if (await discordReview(review)) return; // Discord is the main review place; Bark is the fallback
  await bark(`New clip · ${row.streamer.name}`, `${Math.round(row.clip.durationSec ?? 0)} seconds. Tap to watch and choose Keep or Skip.`,
    { url: `${reviewUrl()}/#clip-${clipId}` });
}

export async function alertFailure(job: Job) {
  const err = redact(job.error ?? '').split('\n')[0].slice(0, 200);
  await bark(`Job failed: ${job.type} #${job.id}`, `After ${job.attempts} attempts. ${err}`, { url: reviewUrl(), level: 'timeSensitive' })
    .catch((e) => log.error('alert failed', { error: String(e) }));
}
