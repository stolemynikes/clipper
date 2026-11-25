// JSON for the dashboard (apps/dashboard). Read-only GETs; actions reuse the existing POST routes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { campaignOpen, type StreamerConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import { campaignNotes } from '../modules/compliance/campaign-notes.ts';
import { readProgress } from '../modules/learner/study.ts';
import { accountWarnings, allStreamers, campaignStatus, expectedPerClip } from './campaigns.ts';
import { bestScores, pendingClips, rating, status } from './review.ts';
import { reasons } from './server.ts';
import { accountStats, earn, LABEL, tokenKey } from './setup.ts';

const DAY = 86_400_000;
type Post = { id: number; clip: number; title: string | null; platform: string; url: string | null; postedAt: number | null; submitted: number; streamer: string; views: number | null };

/** Every post with its latest view count; small table, one query. */
const allPosts = (db: Db) => db.$client.prepare(`
  select p.id, p.clip_id clip, c.title, p.platform, p.url, p.posted_at postedAt, p.submitted, s.name streamer,
    (select views from stats st where st.post_id = p.id order by measured_at desc limit 1) views
  from posts p join clips c on c.id = p.clip_id join moments m on m.id = c.moment_id join sources so on so.id = m.source_id
  join streamers s on s.id = so.streamer_id order by p.posted_at desc`).all() as Post[];

/** Days left including the end date itself (campaignOpen treats endsAt as valid through that day). */
export const daysLeft = (endsAt: string, now = Date.now()) => Math.max(0, Math.ceil((new Date(endsAt).getTime() + DAY - now) / DAY));

function campaignRow(s: StreamerConfig, posts: Post[]) {
  const c = s.campaign!, p = readProgress(s.name), mine = posts.filter((x) => x.streamer === s.name);
  const views = mine.reduce((t, x) => t + (x.views ?? 0), 0);
  const earned = mine.reduce((t, x) => t + earn(x.views ?? 0, c.ratePer1k, c.maxPerClip), 0);
  const { facts, warnings } = campaignNotes(c);
  return {
    name: s.name, tag: s.tag, status: campaignStatus(s, p).label, open: campaignOpen(c), on: s.enabled !== false && campaignOpen(c), stage: s.stage ?? 'clips',
    endsAt: c.endsAt, daysLeft: daysLeft(c.endsAt), ratePer1k: c.ratePer1k, maxPerClip: c.maxPerClip, pool: c.pool ?? null, url: c.url ?? null,
    platforms: (Array.isArray(c.rules?.platforms) ? c.rules.platforms : []).map(String), views, earned, posts: mine.length,
    perClip: expectedPerClip(c, p?.medianShortViews), study: p ? { done: p.done, total: p.total, finished: Boolean(p.finished), error: p.error ?? null } : null,
    facts, warnings: [...warnings, ...accountWarnings(c)],
  };
}

const sum = (rows: { status: string; n: number }[], ...want: string[]) => rows.filter((r) => want.includes(r.status)).reduce((a, r) => a + r.n, 0);

function overview(db: Db) {
  const st = status(db), posts = allPosts(db), camps = allStreamers().filter((s) => s.campaign).map((s) => campaignRow(s, posts));
  const week = Date.now() - 7 * DAY;
  const recentClips = db.$client.prepare(`select c.id, c.status, c.created_at at, s.name streamer from clips c join moments m on m.id = c.moment_id
    join sources so on so.id = m.source_id join streamers s on s.id = so.streamer_id order by c.created_at desc limit 30`).all() as { id: number; status: string; at: number; streamer: string }[];
  const activity = [
    ...recentClips.map((c) => ({ kind: c.status === 'rejected' ? 'skipped' : c.status === 'pending_review' ? 'new' : 'kept', text: `${c.status === 'rejected' ? 'Skipped' : c.status === 'pending_review' ? 'New clip from' : 'Kept'} ${c.streamer}${c.status === 'pending_review' ? '' : ' clip'}`, at: c.at })),
    ...posts.filter((p) => p.postedAt).slice(0, 30).map((p) => ({ kind: 'posted', text: `Posted ${p.streamer} clip to ${LABEL[p.platform as keyof typeof LABEL] ?? p.platform}`, at: p.postedAt! })),
  ].sort((a, b) => b.at - a.at).slice(0, 40);
  return {
    paused: st.paused, working: sum(st.jobs, 'queued', 'running'), failed: sum(st.jobs, 'failed'),
    toReview: sum(st.clips, 'pending_review'), kept: sum(st.clips, 'approved', 'posted'), skipped: sum(st.clips, 'rejected'),
    posted: posts.length, postedThisWeek: posts.filter((p) => (p.postedAt ?? 0) >= week).length,
    views: posts.reduce((t, p) => t + (p.views ?? 0), 0), earned: camps.reduce((t, c) => t + c.earned, 0),
    reviewFrom: [...new Set(pendingClips(db).map((r) => r.streamer.name))],
    campaigns: camps.filter((c) => c.on), endingSoon: camps.filter((c) => c.open && c.daysLeft <= 7).sort((a, b) => a.daysLeft - b.daysLeft),
    canJoin: camps.filter((c) => c.open && !c.on).length, activity,
  };
}

function review(db: Db) {
  const best = bestScores(db), camps = new Map(allStreamers().map((s) => [s.name, s]));
  return pendingClips(db).map(({ clip, moment, source, streamer }) => {
    const sig = (moment.signals ?? {}) as Record<string, number>, c = camps.get(streamer.name)?.campaign;
    return {
      id: clip.id, streamer: streamer.name, seconds: Math.round(clip.durationSec ?? 0), at: clip.createdAt.getTime(), title: clip.title, hook: clip.hook,
      strength: rating(moment.score, best.get(source.id) ?? 0, sig.layoutPenalty ?? 0), reasons: reasons(sig),
      warnings: (clip.compliance?.warnings ?? []) as string[], source: `${source.url}?t=${Math.floor(moment.startSec)}s`,
      platforms: (Array.isArray(c?.rules?.platforms) ? c.rules.platforms : []).map(String), tag: camps.get(streamer.name)?.tag ?? null, maxSec: c?.maxSec ?? null,
    };
  });
}

function detail(db: Db, name: string) {
  const s = allStreamers().find((x) => x.name === name && x.campaign);
  if (!s) return null;
  const posts = allPosts(db), c = s.campaign!;
  return {
    ...campaignRow(s, posts),
    hashtags: (Array.isArray(c.rules?.hashtags) ? c.rules.hashtags : []).map(String), disclosure: c.disclosure !== false,
    clips: posts.filter((p) => p.streamer === name).map((p) => ({ id: p.id, clip: p.clip, title: p.title, platform: LABEL[p.platform as keyof typeof LABEL] ?? p.platform,
      url: p.url, postedAt: p.postedAt, submitted: Boolean(p.submitted), views: p.views ?? 0, earned: earn(p.views ?? 0, c.ratePer1k, c.maxPerClip) })),
  };
}

type Payout = { id: number; campaign: string; amount: number; status: 'pending' | 'paid'; note: string | null; paidAt: number | null; at: number };

/** Estimated earnings per campaign from views, next to what campaigns really paid (payouts table). */
export function earnings(db: Db) {
  const posts = allPosts(db), camps = allStreamers().filter((s) => s.campaign).map((s) => campaignRow(s, posts));
  const payouts = db.$client.prepare('select id, campaign, amount, status, note, paid_at paidAt, created_at at from payouts order by created_at desc').all() as Payout[];
  const total = (st: string) => payouts.filter((p) => p.status === st).reduce((t, p) => t + p.amount, 0);
  return {
    estimated: camps.reduce((t, c) => t + c.earned, 0), paid: total('paid'), pending: total('pending'), payouts,
    campaigns: camps.filter((c) => c.posts || payouts.some((p) => p.campaign === c.name)).map((c) => ({ name: c.name, views: c.views, posts: c.posts, earned: c.earned, pool: c.pool,
      paid: payouts.filter((p) => p.campaign === c.name && p.status === 'paid').reduce((t, p) => t + p.amount, 0) })),
  };
}

/** Every post, newest first, with its estimated earnings. */
function history(db: Db) {
  const camps = new Map(allStreamers().map((s) => [s.name, s.campaign]));
  return allPosts(db).map((p) => { const c = camps.get(p.streamer); return { id: p.id, clip: p.clip, title: p.title, streamer: p.streamer, platform: LABEL[p.platform as keyof typeof LABEL] ?? p.platform,
    url: p.url, postedAt: p.postedAt, submitted: Boolean(p.submitted), views: p.views ?? 0, earned: c ? earn(p.views ?? 0, c.ratePer1k, c.maxPerClip) : 0 }; });
}

/** Accounts with totals; only whether a token exists, never the token. */
const accounts = (db: Db) => accountStats(db).map((a) => ({ ...a, label: LABEL[a.platform], connected: Boolean(process.env[tokenKey(a.id)]) }));

const json = (res: ServerResponse, body: unknown) => res.writeHead(body === null ? 404 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));

/** GET /api/*: true if handled. */
export function apiRoute(db: Db, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/api/overview') return json(res, overview(db)), true;
  if (url.pathname === '/api/review') return json(res, review(db)), true;
  if (url.pathname === '/api/campaigns') return json(res, allStreamers().filter((s) => s.campaign).map((s) => campaignRow(s, allPosts(db)))), true;
  if (url.pathname === '/api/earnings') return json(res, earnings(db)), true;
  if (url.pathname === '/api/history') return json(res, history(db)), true;
  if (url.pathname === '/api/accounts') return json(res, accounts(db)), true;
  const m = /^\/api\/campaigns\/([a-z0-9_]{2,25})$/.exec(url.pathname);
  if (m) return json(res, detail(db, m[1])), true;
  return false;
}
