import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { activeStreamers, loadSettings } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { moments, sources, streamers } from '../../db/schema.ts';
import { paths } from '../../env.ts';
import { logger } from '../../log.ts';
import { runCmd } from '../../proc.ts';
import { enqueue } from '../../queue/queue.ts';
import { getVod, getVodClips } from '../../twitch.ts';
import { pickMoments, type ChatMessage } from './scoring.ts';

const log = logger('vod-clipper');

/** TwitchDownloaderCLI chat JSON -> messages. */
export function parseChat(json: { comments?: { content_offset_seconds: number; commenter?: { display_name?: string }; message?: { body?: string } }[] }): ChatMessage[] {
  return (json.comments ?? []).map((c) => ({ t: c.content_offset_seconds, text: c.message?.body ?? '', user: c.commenter?.display_name ?? '' }));
}

export function sourceContext(db: Db, sourceId: number) {
  const source = db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!source) throw new Error(`source ${sourceId} not found`);
  const streamer = db.select().from(streamers).where(eq(streamers.id, source.streamerId!)).get();
  const cfg = activeStreamers().find((s) => s.name === streamer?.name);
  if (!cfg) throw new Error(`streamer of source ${sourceId} has no active campaign; stopping (hard rule)`);
  return { source, cfg };
}

export async function analyzeVod(db: Db, { sourceId, vodId, practice }: { sourceId: number; vodId: string; practice?: boolean }) {
  const { source, cfg } = sourceContext(db, sourceId);
  if (db.select().from(moments).where(eq(moments.sourceId, sourceId)).get()) return log.info(`source ${sourceId} already analyzed`);
  const settings = loadSettings();
  const dir = join(paths.dataDir, 'work', String(sourceId));
  mkdirSync(dir, { recursive: true });

  const vod = await getVod(vodId);
  const chatFile = join(dir, 'chat.json');
  await runCmd(join(paths.toolsDir, 'TwitchDownloaderCLI.exe'),
    ['chatdownload', '--id', vodId, '-o', chatFile, '--compression', 'None', '--collision', 'Overwrite', '--temp-path', process.env.TEMP ?? dir]);
  const chat = parseChat(JSON.parse(readFileSync(chatFile, 'utf8')));
  const viewerClips = (await getVodClips(vod)).map((c) => ({ offset: c.vod_offset!, duration: c.duration }));
  rmSync(chatFile, { force: true });

  const limits = { minSec: settings.clip.minSec, maxSec: Math.min(settings.clip.maxSec, cfg.campaign?.maxSec ?? Infinity) };
  // shortcut: audioPeak not computed yet (needs the full audio track); weight has no effect until it is.
  const picked = pickMoments({ durationSec: source.durationSec ?? 0, chat, viewerClips }, settings.scoring, limits);

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
