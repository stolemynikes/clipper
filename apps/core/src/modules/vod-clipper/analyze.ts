import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { activeStreamers, loadSettings } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { moments, sources, streamers } from '../../db/schema.ts';
import { paths } from '../../env.ts';
import { logger } from '../../log.ts';
import { runCmd } from '../../proc.ts';
import { enqueue, Stop } from '../../queue/queue.ts';
import { getVod, getVodClips } from '../../twitch.ts';
import { pickMoments, type ChatMessage, type Moment, type ScoringConfig } from './scoring.ts';
import { loudness } from '../watcher/footage.ts';

const log = logger('vod-clipper');

/** TwitchDownloaderCLI chat JSON -> messages. */
export function parseChat(json: { comments?: { content_offset_seconds: number; commenter?: { display_name?: string }; message?: { body?: string } }[] }): ChatMessage[] {
  return (json.comments ?? []).map((c) => ({ t: c.content_offset_seconds, text: c.message?.body ?? '', user: c.commenter?.display_name ?? '' }));
}

/** Silent stretches of at least minGap seconds (also before the first and after the last message), as [from, to]. */
export function chatGaps(times: number[], durationSec: number, minGap = 600): [number, number][] {
  const t = [0, ...[...times].sort((a, b) => a - b), durationSec], gaps: [number, number][] = [];
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] >= minGap) gaps.push([Math.floor(t[i - 1]), Math.ceil(t[i])]);
  return gaps;
}

/** Whole-VOD chat. A full download of a very long VOD can silently miss hours (seen: 90k-98k s of a 47 h stream),
 *  so silent stretches are fetched again on their own and merged. */
async function downloadChat(vodId: string, dir: string, durationSec: number): Promise<ChatMessage[]> {
  const exe = join(paths.toolsDir, 'TwitchDownloaderCLI.exe'), file = join(dir, 'chat.json');
  const get = async (range: string[], timeoutMs: number) => {
    await runCmd(exe, ['chatdownload', '--id', vodId, ...range, '-o', file, '--compression', 'None', '--collision', 'Overwrite', '--temp-path', process.env.TEMP ?? dir], { timeoutMs });
    try { return parseChat(JSON.parse(readFileSync(file, 'utf8'))); } finally { rmSync(file, { force: true }); }
  };
  const chat = await get([], 90 * 60_000);
  const gaps = chat.length ? chatGaps(chat.map((c) => c.t), durationSec).slice(0, 30) : [];
  for (const [from, to] of gaps) {
    const more = (await get(['-b', `${from}s`, '-e', `${to}s`], 30 * 60_000)).filter((c) => c.t > from && c.t < to);
    if (more.length) log.warn(`chat gap ${from}-${to}s refilled with ${more.length} messages`);
    chat.push(...more);
  }
  return chat.sort((a, b) => a.t - b.t);
}

export function sourceContext(db: Db, sourceId: number) {
  const source = db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!source) throw new Error(`source ${sourceId} not found`);
  const streamer = db.select().from(streamers).where(eq(streamers.id, source.streamerId!)).get();
  const cfg = activeStreamers().find((s) => s.name === streamer?.name);
  if (!cfg) throw new Stop(`streamer of source ${sourceId} has no active campaign; stopping (hard rule)`);
  return { source, cfg };
}

const NO_SIGNALS = { chatRate: 0, emoteScore: 0, viewerClipHits: 0, audioPeak: 0 };

/** Footage has no chat: loud stretches (laughs, shouting) pick the moments, the judge sorts them after render.
 *  A video that already fits a clip is taken whole. About one moment per 10 minutes, at most 5 per video. */
export function footagePick(durationSec: number, audio: number[], scoring: ScoringConfig, limits: { minSec: number; maxSec: number }): Moment[] {
  if (durationSec <= limits.maxSec) return durationSec >= Math.min(limits.minSec, 10) ? [{ start: 0, end: durationSec, score: 1, peakAt: durationSec / 2, signals: NO_SIGNALS }] : [];
  const cfg = { ...scoring, weights: { chatRate: 0, emoteScore: 0, viewerClipHits: 0, audioPeak: 1 } };
  return pickMoments({ durationSec, chat: [], audio }, cfg, limits).slice(0, Math.min(5, Math.max(1, Math.round(durationSec / 600))));
}

export async function footageMoments(file: string, durationSec: number, scoring: ScoringConfig, limits: { minSec: number; maxSec: number }) {
  return footagePick(durationSec, durationSec > limits.maxSec ? await loudness(file, scoring.windowSec) : [], scoring, limits);
}

export async function analyzeVod(db: Db, { sourceId, vodId, practice }: { sourceId: number; vodId: string; practice?: boolean }) {
  const { source, cfg } = sourceContext(db, sourceId);
  if (db.select().from(moments).where(eq(moments.sourceId, sourceId)).get()) return log.info(`source ${sourceId} already analyzed`);
  const settings = loadSettings();
  const dir = join(paths.dataDir, 'work', String(sourceId));
  mkdirSync(dir, { recursive: true });

  const limits = { minSec: settings.clip.minSec, maxSec: Math.min(settings.clip.maxSec, cfg.campaign?.maxSec ?? Infinity) };
  let chat: ChatMessage[] = [], viewerClips: { offset: number; duration: number }[] = [], picked: Moment[];
  if (cfg.platform === 'footage') picked = await footageMoments(source.url, source.durationSec ?? 0, settings.scoring, limits);
  else {
    const vod = await getVod(vodId);
    chat = await downloadChat(vodId, dir, source.durationSec ?? 0);
    viewerClips = (await getVodClips(vod)).map((c) => ({ offset: c.vod_offset!, duration: c.duration }));
    // shortcut: audioPeak not computed for VODs yet (needs the full audio track); weight has no effect until it is.
    picked = pickMoments({ durationSec: source.durationSec ?? 0, chat, viewerClips }, settings.scoring, limits);
  }

  for (const m of picked) {
    const row = db.insert(moments).values({ sourceId, startSec: m.start, endSec: m.end, score: m.score, signals: { ...m.signals, peakAt: m.peakAt } }).returning().get();
    // Chat of this moment (clip-relative times) for the editor's chat overlay.
    const clipDir = join(paths.dataDir, 'clips', String(row.id));
    mkdirSync(clipDir, { recursive: true });
    writeFileSync(join(clipDir, 'chat.json'), JSON.stringify(chat.filter((c) => c.t >= m.start && c.t < m.end).map((c) => ({ ...c, t: c.t - m.start }))));
    enqueue(db, practice ? 'practice.render' : 'clip.render', { momentId: row.id, practice });
  }
  db.update(sources).set({ status: 'analyzed' }).where(eq(sources.id, sourceId)).run();
  log.info(`source ${sourceId}: ${chat.length} chat msgs, ${viewerClips.length} viewer clips -> ${picked.length} moments`);
}
