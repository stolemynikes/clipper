// Does an approved proposal pay off in real views? Compare own posts before and after it went live,
// each post counted at the same age (2 days) so newer posts are not judged on fewer hours.
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { clips, moments, posts, sources, stats, streamers } from '../../db/schema.ts';
import type { Kind } from '../learner/patterns.ts';
import { kindFor, kindOf, type Proposal } from './proposals.ts';

export const AGE_MS = 2 * 86_400_000, WINDOW_MS = 14 * 86_400_000, MIN_POSTS = 5;
export type PostViews = { kind: Kind; streamer: string; postedAt: number; views: number };
export type Side = { n: number; median: number | null };

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Posts of the proposal's kind (and streamer, for a per-streamer change) in the 14 days before vs after it went live. */
export function beforeAfter(p: Proposal, rows: PostViews[]) {
  if (p.status !== 'approved' || !p.decided) return null;
  const only = Object.keys(p.change.gameCrop ?? {}), kind = kindOf(p), at = p.decided;
  const mine = rows.filter((r) => r.kind === kind && (!only.length || only.includes(r.streamer)));
  const side = (xs: PostViews[]): Side => ({ n: xs.length, median: median(xs.map((x) => x.views)) });
  return {
    before: side(mine.filter((r) => r.postedAt < at && r.postedAt >= at - WINDOW_MS)),
    after: side(mine.filter((r) => r.postedAt >= at && r.postedAt < at + WINDOW_MS)),
    enough: MIN_POSTS,
  };
}

/** Own posts at least 2 days old, with the highest views measured within their first 2 days. */
export function postViews(db: Db, now = Date.now()): PostViews[] {
  const rows = db.select({ id: posts.id, postedAt: posts.postedAt, views: stats.views, at: stats.measuredAt, name: streamers.name, platform: streamers.platform, config: streamers.config })
    .from(posts).innerJoin(stats, eq(stats.postId, posts.id)).innerJoin(clips, eq(clips.id, posts.clipId))
    .innerJoin(moments, eq(moments.id, clips.momentId)).innerJoin(sources, eq(sources.id, moments.sourceId))
    .innerJoin(streamers, eq(streamers.id, sources.streamerId)).all();
  const best = new Map<number, PostViews>();
  for (const r of rows) {
    const t = r.postedAt?.getTime();
    if (t == null || now - t < AGE_MS || r.at.getTime() - t > AGE_MS) continue;
    const kind = kindFor({ platform: r.platform, genre: (r.config as { genre?: string } | null)?.genre } as Parameters<typeof kindFor>[0]);
    const old = best.get(r.id);
    if (!old || r.views > old.views) best.set(r.id, { kind, streamer: r.name, postedAt: t, views: r.views });
  }
  return [...best.values()];
}
