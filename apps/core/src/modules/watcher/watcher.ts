import { and, eq } from 'drizzle-orm';
import { activeStreamers, loadSettings, type StreamerConfig } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { sources, streamers } from '../../db/schema.ts';
import { logger } from '../../log.ts';
import { enqueue } from '../../queue/queue.ts';
import { getUserId, getVod, listVods, parseDuration, vodIdFromUrl, type Vod } from '../../twitch.ts';

const log = logger('watcher');

export function ensureStreamer(db: Db, cfg: StreamerConfig, channelId: string) {
  const found = db.select().from(streamers).where(and(eq(streamers.platform, cfg.platform), eq(streamers.channelId, channelId))).get();
  if (found) {
    db.update(streamers).set({ name: cfg.name, config: cfg as any }).where(eq(streamers.id, found.id)).run();
    return found;
  }
  return db.insert(streamers).values({ name: cfg.name, platform: cfg.platform, channelId, config: cfg as any }).returning().get();
}

/** Inserts the VOD as a source and queues analysis. Returns false if it was already known. */
export function addVod(db: Db, vod: Vod, streamerId: number): boolean {
  const row = db.insert(sources)
    .values({ url: vod.url, streamerId, durationSec: parseDuration(vod.duration) })
    .onConflictDoNothing().returning().get();
  if (!row) return false;
  enqueue(db, 'vod.analyze', { sourceId: row.id, vodId: vod.id });
  log.info(`queued ${vod.url} (${vod.user_login}, ${vod.duration})`);
  return true;
}

/** Manual entry (`npm run clip <url>`). Refuses VODs of streamers without an active campaign. */
export async function addVodUrl(db: Db, url: string): Promise<boolean> {
  const id = vodIdFromUrl(url);
  if (!id) throw new Error(`not a Twitch VOD url: ${url}`);
  const vod = await getVod(id);
  const cfg = activeStreamers().find((s) => s.platform === 'twitch' && s.channel.toLowerCase() === vod.user_login.toLowerCase());
  if (!cfg) throw new Error(`${vod.user_login} has no active campaign in config/streamers.yaml; refusing (hard rule)`);
  return addVod(db, vod, ensureStreamer(db, cfg, vod.user_id).id);
}

/** One pass over all active Twitch streamers: queue new, finished VODs. */
export async function watchOnce(db: Db, now = Date.now()) {
  const { watcher } = loadSettings();
  for (const cfg of activeStreamers().filter((s) => s.platform === 'twitch')) {
    try {
      const userId = await getUserId(cfg.channel);
      const streamerId = ensureStreamer(db, cfg, userId).id;
      for (const vod of await listVods(userId)) {
        const start = new Date(vod.created_at).getTime();
        if (now - start > watcher.maxVodAgeDays * 86_400_000) continue;
        // shortcut: a VOD still growing (stream live) is skipped until it stops for 15 min; live clipping is phase 3.
        if (start + parseDuration(vod.duration) * 1000 > now - 15 * 60_000) continue;
        addVod(db, vod, streamerId);
      }
    } catch (err) {
      log.error(`watch ${cfg.name} failed`, { error: String(err) });
    }
  }
}
