// YouTube channels as a source: new long uploads via yt-dlp's flat playlist (no API key or quota needed).
import { clipStreamers, type StreamerConfig } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { sources } from '../../db/schema.ts';
import { logger } from '../../log.ts';
import { runCmd } from '../../proc.ts';
import { enqueue } from '../../queue/queue.ts';
import { ensureStreamer } from './watcher.ts';

const log = logger('youtube-watch');
const LATEST = 5, PER_PASS = 3, MIN_SEC = 120; // under 2 min is a Short: nothing to clip from

/** Channel id (UC...), @handle or bare handle to its uploads page. */
export const channelUrl = (c: string) => `https://www.youtube.com/${/^UC[\w-]{22}$/.test(c) ? `channel/${c}` : c.startsWith('@') ? c : `@${c}`}/videos`;

type Entry = { id?: string; duration?: number | null; live_status?: string | null };

/** Uploads worth queueing: real video id, long enough, not live or upcoming. */
export const usable = (e: Entry) => /^[\w-]{11}$/.test(e.id ?? '') && (e.duration ?? 0) >= MIN_SEC && !['is_live', 'is_upcoming'].includes(e.live_status ?? '');

export async function watchYoutube(db: Db) {
  for (const cfg of clipStreamers().filter((s) => s.platform === 'youtube')) {
    try { await watchOne(db, cfg); } catch (err) { log.error(`youtube ${cfg.name} failed`, { error: String(err).slice(0, 300) }); }
  }
}

async function watchOne(db: Db, cfg: StreamerConfig) {
  const list = JSON.parse(await runCmd('yt-dlp', ['-J', '--flat-playlist', '--playlist-end', String(LATEST), '--no-warnings', channelUrl(cfg.channel)], { timeoutMs: 120_000 })) as { entries?: Entry[] };
  const streamerId = ensureStreamer(db, cfg, cfg.channel).id;
  let added = 0;
  for (const e of (list.entries ?? []).filter(usable)) {
    if (added >= PER_PASS) break;
    const row = db.insert(sources).values({ url: `https://www.youtube.com/watch?v=${e.id}`, streamerId, durationSec: Math.round(e.duration!) }).onConflictDoNothing().returning().get();
    if (!row) continue;
    enqueue(db, 'vod.analyze', { sourceId: row.id, vodId: '' });
    added++;
  }
  if (added) log.info(`${cfg.name}: queued ${added} YouTube videos`);
}
