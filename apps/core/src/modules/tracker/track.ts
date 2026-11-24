// Views and likes per post, from the official APIs with the account's own token. Feeds earnings on the Accounts page.
import { enqueue } from '../../queue/queue.ts';
import { and, count, eq, gte, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { accounts, posts, stats } from '../../db/schema.ts';
import { logger } from '../../log.ts';
import type { Platform } from '../../review/setup.ts';
import { accessToken } from '../publisher/oauth.ts';
import { tiktokApi } from '../publisher/publish.ts';
import { hasPostpeer, postpeerStats, statsDue } from '../publisher/postpeer.ts';

const log = logger('tracker');
const TRACK_DAYS = 30;
type Row = { id: number; externalId: string; url: string | null };
type Count = { views: number; likes: number | null; url?: string };

export const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function youtube(token: string, rows: Row[]) {
  const out = new Map<string, Count>();
  for (const part of chunk(rows, 50)) {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${part.map((p) => p.externalId).join(',')}`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`YouTube stats failed: ${r.status}`);
    for (const v of ((await r.json()) as { items?: { id: string; statistics: { viewCount?: string; likeCount?: string } }[] }).items ?? []) {
      out.set(v.id, { views: Number(v.statistics.viewCount ?? 0), likes: v.statistics.likeCount ? Number(v.statistics.likeCount) : null });
    }
  }
  return out;
}

async function tiktok(db: Db, token: string, rows: Row[]) {
  // A fresh post only has a publish id; TikTok gives the real post id once processing is done (never for private posts).
  for (const p of rows.filter((x) => x.externalId.startsWith('publish:'))) {
    const s = await tiktokApi<{ status: string; publicaly_available_post_id?: (string | number)[]; fail_reason?: string }>(
      token, 'post/publish/status/fetch/', { publish_id: p.externalId.slice(8) });
    const postId = s.publicaly_available_post_id?.[0]; // sic: TikTok's spelling
    if (s.status === 'FAILED') log.warn(`TikTok post ${p.id} failed: ${s.fail_reason ?? 'unknown'}`);
    if (postId) { p.externalId = String(postId); db.update(posts).set({ externalId: p.externalId }).where(eq(posts.id, p.id)).run(); }
  }
  const out = new Map<string, Count>();
  for (const part of chunk(rows.filter((x) => !x.externalId.startsWith('publish:')), 20)) {
    const d = await tiktokApi<{ videos: { id: string; view_count?: number; like_count?: number; share_url?: string }[] }>(
      token, 'video/query/?fields=id,view_count,like_count,share_url', { filters: { video_ids: part.map((p) => p.externalId) } });
    for (const v of d.videos) out.set(String(v.id), { views: v.view_count ?? 0, likes: v.like_count ?? null, url: v.share_url });
  }
  return out;
}

/** One pass over posts from the last 30 days. One failing account does not stop the others. */
export async function trackOnce(db: Db, now = new Date()) {
  const since = new Date(now.getTime() - TRACK_DAYS * 86_400_000);
  const rows = db.select({ id: posts.id, externalId: posts.externalId, url: posts.url, postedAt: posts.postedAt, accountId: posts.accountId, platform: accounts.platform })
    .from(posts).innerJoin(accounts, eq(accounts.id, posts.accountId))
    .where(and(isNotNull(posts.externalId), gte(posts.postedAt, since))).all() as (Row & { postedAt: Date | null; accountId: number; platform: Platform })[];
  const save = (p: Row, c: Count) => {
    db.insert(stats).values({ postId: p.id, views: c.views, likes: c.likes, measuredAt: now }).run();
    if (c.url && c.url !== p.url) {
      db.update(posts).set({ url: c.url }).where(eq(posts.id, p.id)).run();
      if (!p.url) enqueue(db, 'post.submit', { postId: p.id }); // link known only now
    }
  };
  if (hasPostpeer()) {
    for (const p of rows.filter((x) => x.externalId.startsWith('pp:'))) {
      const [{ n }] = db.select({ n: count() }).from(stats).where(eq(stats.postId, p.id)).all();
      if (!p.postedAt || !statsDue((now.getTime() - p.postedAt.getTime()) / 86_400_000, n)) continue;
      try { save(p, await postpeerStats(p.externalId.slice(3))); } catch (e) { log.warn(`stats for post ${p.id} failed: ${(e as Error).message}`); }
    }
  }
  const byAccount = new Map<number, typeof rows>();
  for (const r of rows.filter((x) => !x.externalId.startsWith('pp:'))) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);
  for (const [accountId, list] of byAccount) {
    try {
      const token = await accessToken(accountId, list[0].platform);
      const counts = list[0].platform === 'youtube' ? await youtube(token, list) : await tiktok(db, token, list);
      for (const p of list) {
        const c = counts.get(p.externalId);
        if (c) save(p, c);
      }
    } catch (e) {
      log.warn(`stats for account ${accountId} failed: ${(e as Error).message}`);
    }
  }
}
