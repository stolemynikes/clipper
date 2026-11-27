// JSON for the dashboard (apps/dashboard). Read-only GETs; actions reuse the existing POST routes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { aaBias, proposals, score } from '../modules/practice/proposals.ts';
import { campaignOpen, loadSettings, type StreamerConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import { campaignNotes } from '../modules/compliance/campaign-notes.ts';
import { readProgress } from '../modules/learner/study.ts';
import { accountWarnings, allStreamers, campaignStatus, expectedPerClip } from './campaigns.ts';
import { bestScores, isOff, pendingClips, rating, status } from './review.ts';
import { reasons } from './server.ts';
import { isPractice } from '../modules/practice/practice.ts';
import { accountStats, accountVia, connectUrl, earn, LABEL, setupInfo, tokenKey } from './setup.ts';
import { getSettings } from './settings.ts';
import { existsSync } from 'node:fs';
import { desc, eq, gte, inArray, and } from 'drizzle-orm';
import { accounts as accountRows, clips, moments, posts as postRows } from '../db/schema.ts';
import { sourceContext } from '../modules/vod-clipper/analyze.ts';
import { campaignAllows, canUpload, clipText } from '../modules/publisher/publish.ts';
import type { AccountPlatform } from './setup.ts';
import { cachedDiscover, cachedKinds, crState, twitchOf, whyNot } from '../modules/scout/scout.ts';

const DAY = 86_400_000;
type Post = { id: number; clip: number; account: number; title: string | null; platform: string; url: string | null; postedAt: number | null; submitted: number; streamer: string; views: number | null };

/** Every post with its latest view count; small table, one query. */
const allPosts = (db: Db) => db.$client.prepare(`
  select p.id, p.clip_id clip, p.account_id account, c.title, p.platform, p.url, p.posted_at postedAt, p.submitted, s.name streamer,
    (select views from stats st where st.post_id = p.id order by measured_at desc limit 1) views
  from posts p join clips c on c.id = p.clip_id join moments m on m.id = c.moment_id join sources so on so.id = m.source_id
  join streamers s on s.id = so.streamer_id order by p.posted_at desc`).all() as Post[];

/** Days left including the end date itself (campaignOpen treats endsAt as valid through that day). */
export const daysLeft = (endsAt: string, now = Date.now()) => Math.max(0, Math.ceil((new Date(endsAt).getTime() + DAY - now) / DAY));

function campaignRow(s: StreamerConfig, posts: Post[]) {
  const c = s.campaign!, p = readProgress(s.name), mine = posts.filter((x) => x.streamer === s.name);
  const views = mine.reduce((t, x) => t + (x.views ?? 0), 0);
  const earned = mine.reduce((t, x) => t + earn(x.views ?? 0, c.ratePer1k, c.maxPerClip), 0);
  const { facts, warnings } = campaignNotes(c), cr = c.platform === 'content_rewards' ? crState(c.url, [s.name, s.channel]) : null;
  return {
    closed: Boolean(cr?.closed), budget: cr?.budget || null, left: cr?.budget ? cr.left : null,
    name: s.name, tag: s.tag, site: c.platform, status: campaignStatus(s, p).label, open: campaignOpen(c), on: s.enabled === true && campaignOpen(c), stage: s.stage ?? 'clips',
    endsAt: c.endsAt, daysLeft: daysLeft(c.endsAt), ratePer1k: c.ratePer1k, maxPerClip: c.maxPerClip, pool: c.pool ?? null, url: c.url ?? null,
    platforms: (Array.isArray(c.rules?.platforms) ? c.rules.platforms : []).map(String), views, earned, posts: mine.length,
    perClip: expectedPerClip(c, p?.medianShortViews), study: p ? { done: p.done, total: p.total, finished: Boolean(p.finished), error: p.error ?? null } : null,
    facts, warnings: [...warnings, ...accountWarnings(c)],
  };
}

/** Views and estimated earnings at time t, from the stats history (latest measurement at or before t). */
function timeline(db: Db, posts: Post[]) {
  const camps = new Map(allStreamers().map((s) => [s.name, s.campaign]));
  const rows = db.$client.prepare('select post_id p, views v, measured_at t from stats order by measured_at').all() as { p: number; v: number; t: number }[];
  const of = new Map(posts.map((p) => [p.id, p]));
  return (t: number) => {
    const last = new Map<number, number>();
    for (const r of rows) if (r.t <= t) last.set(r.p, r.v);
    let views = 0, earned = 0;
    for (const [id, v] of last) { const c = camps.get(of.get(id)?.streamer ?? ''); views += v; if (c) earned += earn(v, c.ratePer1k, c.maxPerClip); }
    return { views, earned };
  };
}

const sum = (rows: { status: string; n: number }[], ...want: string[]) => rows.filter((r) => want.includes(r.status)).reduce((a, r) => a + r.n, 0);

function overview(db: Db) {
  const st = status(db), posts = allPosts(db), camps = allStreamers().filter((s) => s.campaign).map((s) => campaignRow(s, posts));
  const now = Date.now(), week = now - 7 * DAY, at = timeline(db, posts), wk = at(week), wk2 = at(now - 14 * DAY);
  const end = new Date(); end.setHours(24, 0, 0, 0); // end of today
  const earnedSeries = Array.from({ length: 30 }, (_, i) => at(end.getTime() - (29 - i) * DAY).earned);
  const views = posts.reduce((t, p) => t + (p.views ?? 0), 0), earned = camps.reduce((t, c) => t + c.earned, 0), pending = pendingClips(db);
  const recentClips = db.$client.prepare(`select c.id, c.status, c.created_at at, s.name streamer from clips c join moments m on m.id = c.moment_id
    join sources so on so.id = m.source_id join streamers s on s.id = so.streamer_id where c.status != 'practice' order by c.created_at desc limit 30`).all() as { id: number; status: string; at: number; streamer: string }[];
  const activity = [
    ...recentClips.map((c) => ({ kind: c.status === 'rejected' ? 'skipped' : c.status === 'pending_review' ? 'new' : 'kept', text: `${c.status === 'rejected' ? 'Skipped' : c.status === 'pending_review' ? 'New clip from' : 'Kept'} ${c.streamer}${c.status === 'pending_review' ? '' : ' clip'}`, at: c.at })),
    ...posts.filter((p) => p.postedAt).slice(0, 30).map((p) => ({ kind: 'posted', text: `Posted ${p.streamer} clip to ${LABEL[p.platform as keyof typeof LABEL] ?? p.platform}`, at: p.postedAt! })),
  ].sort((a, b) => b.at - a.at).slice(0, 40);
  return {
    paused: st.paused, study: !isOff('study'), learning: !isOff('learn'), practice: isPractice(), claude: !isOff('claude'), working: sum(st.jobs, 'queued', 'running'), failed: sum(st.jobs, 'failed'),
    toReview: sum(st.clips, 'pending_review'), toPost: ready(db).filter((c) => !c.accounts.length || c.accounts.some((a) => !a.posted)).length, kept: sum(st.clips, 'approved', 'posted'), skipped: sum(st.clips, 'rejected'),
    posted: posts.length, postedThisWeek: posts.filter((p) => (p.postedAt ?? 0) >= week).length,
    views, earned, earnedSeries, earnedWeek: earned - wk.earned, viewsWeek: views - wk.views, viewsPrevWeek: wk.views - wk2.views,
    reviewFrom: [...new Set(pending.map((r) => r.streamer.name))], reviewIds: pending.slice(0, 3).map((r) => r.clip.id),
    sites: [...new Set(camps.map((c) => c.site))],
    campaigns: camps.filter((c) => c.on), endingSoon: camps.filter((c) => c.open && c.daysLeft <= 7).sort((a, b) => a.daysLeft - b.daysLeft),
    canJoin: camps.filter((c) => c.open && !c.on).length, activity,
  };
}

function review(db: Db) {
  const best = bestScores(db), camps = new Map(allStreamers().map((s) => [s.name, s])), on = loadSettings().platforms;
  return pendingClips(db).map(({ clip, moment, source, streamer }) => {
    const sig = (moment.signals ?? {}) as Record<string, number>, c = camps.get(streamer.name)?.campaign;
    return {
      id: clip.id, streamer: streamer.name, seconds: Math.round(clip.durationSec ?? 0), at: clip.createdAt.getTime(), title: clip.title, hook: clip.hook,
      strength: rating(moment.score, best.get(source.id) ?? 0, sig.layoutPenalty ?? 0), reasons: reasons(sig),
      warnings: (clip.compliance?.warnings ?? []) as string[], source: `${source.url}?t=${Math.floor(moment.startSec)}s`,
      platforms: (Array.isArray(c?.rules?.platforms) ? c.rules.platforms : []).map(String).filter((p) => on[p as keyof typeof on]), tag: camps.get(streamer.name)?.tag ?? null, maxSec: c?.maxSec ?? null, // platforms: only where the publisher posts
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
    campaigns: camps.filter((c) => c.on || c.posts || payouts.some((p) => p.campaign === c.name)).map((c) => ({ name: c.name, site: c.site, status: c.status, open: c.open,
      endsAt: c.endsAt, daysLeft: c.daysLeft, views: c.views, posts: c.posts, earned: c.earned, pool: c.pool,
      paid: payouts.filter((p) => p.campaign === c.name && p.status === 'paid').reduce((t, p) => t + p.amount, 0) })),
    platforms: byPlatform(posts),
  };
}

/** Views and posts per platform, with each platform's share of all views. */
function byPlatform(posts: Post[]) {
  const m = new Map<string, { platform: string; views: number; posts: number }>();
  for (const p of posts) { const r = m.get(p.platform) ?? { platform: p.platform, views: 0, posts: 0 }; r.views += p.views ?? 0; r.posts++; m.set(p.platform, r); }
  const all = posts.reduce((t, p) => t + (p.views ?? 0), 0);
  return [...m.values()].map((r) => ({ ...r, label: LABEL[r.platform as keyof typeof LABEL] ?? r.platform, share: all ? r.views / all : 0 })).sort((a, b) => b.views - a.views);
}

/** Per month totals, ended campaigns, and every post newest first with its estimated earnings. */
function history(db: Db) {
  const all = allPosts(db), camps = new Map(allStreamers().map((s) => [s.name, s.campaign]));
  const posts = all.map((p) => { const c = camps.get(p.streamer); return { id: p.id, clip: p.clip, title: p.title, streamer: p.streamer, platform: LABEL[p.platform as keyof typeof LABEL] ?? p.platform,
    url: p.url, postedAt: p.postedAt, submitted: Boolean(p.submitted), views: p.views ?? 0, earned: c ? earn(p.views ?? 0, c.ratePer1k, c.maxPerClip) : 0 }; });
  const paid = db.$client.prepare("select campaign, amount, coalesce(paid_at, created_at) at from payouts where status = 'paid'").all() as { campaign: string; amount: number; at: number }[];
  const month = (t: number) => new Date(t).toISOString().slice(0, 7);
  const months = new Map<string, { month: string; streamers: Set<string>; clips: number; views: number; earned: number; paid: number }>();
  const get = (k: string) => months.get(k) ?? months.set(k, { month: k, streamers: new Set(), clips: 0, views: 0, earned: 0, paid: 0 }).get(k)!;
  for (const p of posts) if (p.postedAt) { const m = get(month(p.postedAt)); m.streamers.add(p.streamer); m.clips++; m.views += p.views; m.earned += p.earned; }
  for (const p of paid) get(month(p.at)).paid += p.amount;
  const ended = allStreamers().filter((s) => s.campaign && !campaignOpen(s.campaign)).map((s) => campaignRow(s, all))
    .map((c) => ({ name: c.name, endsAt: c.endsAt, earned: c.earned, posts: c.posts, paid: paid.filter((p) => p.campaign === c.name).reduce((t, p) => t + p.amount, 0) }))
    .sort((a, b) => b.endsAt.localeCompare(a.endsAt));
  return { months: [...months.values()].map(({ streamers, ...m }) => ({ ...m, campaigns: streamers.size })).sort((a, b) => b.month.localeCompare(a.month)), ended, posts };
}

/** Accounts with totals; only whether a token exists, never the token. */
function accounts(db: Db) {
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const posts = allPosts(db), today = (id: number) => posts.filter((p) => p.account === id && (p.postedAt ?? 0) >= day.getTime()).length;
  // Best times: average views per post by weekday (0 = Monday) and hour posted, last 30 days.
  const hours = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ views: 0, posts: 0 })));
  for (const p of posts) if (p.postedAt && p.postedAt >= Date.now() - 30 * DAY) { const d = new Date(p.postedAt), h = hours[(d.getDay() + 6) % 7][d.getHours()]; h.views += p.views ?? 0; h.posts++; }
  return {
    limit: loadSettings().limits.maxPostsPerAccountPerDay, hours: hours.map((d) => d.map((h) => (h.posts ? Math.round(h.views / h.posts) : null))),
    accounts: accountStats(db).map((a) => ({ ...a, label: LABEL[a.platform], connected: Boolean(process.env[tokenKey(a.id)]), today: today(a.id), via: accountVia(a.platform), connectUrl: connectUrl(a) })),
    ...setupInfo(db),
  };
}

/** Ready to post: kept clips of the last 14 days, per account of that streamer the text to copy, the link if posted, and whether Snip can upload it. */
function ready(db: Db) {
  const on = loadSettings().platforms;
  const list = db.select({ clip: clips, sourceId: moments.sourceId }).from(clips).innerJoin(moments, eq(clips.momentId, moments.id))
    .where(and(inArray(clips.status, ['approved', 'posted']), gte(clips.createdAt, new Date(Date.now() - 14 * DAY)))).orderBy(desc(clips.createdAt)).limit(40).all();
  return list.flatMap(({ clip, sourceId }) => {
    let ctx;
    try { ctx = sourceContext(db, sourceId); } catch { return []; } // campaign ended: hard rule, never post it
    const { source, cfg } = ctx;
    const done = db.select().from(postRows).where(eq(postRows.clipId, clip.id)).all();
    const accs = source.streamerId ? db.select().from(accountRows).where(eq(accountRows.streamerId, source.streamerId)).all() : [];
    return [{
      id: clip.id, streamer: cfg.name, title: clip.title, seconds: Math.round(clip.durationSec ?? 0), at: clip.createdAt.getTime(), file: existsSync(clip.filePath),
      accounts: accs.filter((a) => on[a.platform] && campaignAllows(cfg.campaign?.rules, a.platform))
        // one clip goes to one account per platform (CR "reused content"), so hide the others once it is up somewhere
        .filter((a) => !done.some((p) => p.platform === a.platform && p.accountId !== a.id))
        .map((a) => ({ id: a.id, platform: a.platform, label: LABEL[a.platform], name: a.name, canPost: canUpload(a),
          url: done.find((p) => p.accountId === a.id)?.url ?? null, posted: done.some((p) => p.accountId === a.id), text: clipText(clip, cfg, a.platform as AccountPlatform).text })),
    }];
  }).sort((a, b) => Number(a.accounts.every((x) => x.posted)) - Number(b.accounts.every((x) => x.posted)));
}

// USD to EUR from the ECB daily reference rates (public file, no personal data), cached 12 hours.
let rate: { eurPerUsd: number; date: string; at: number } | null = null;
async function usdRate() {
  if (rate && Date.now() - rate.at < 12 * 3_600_000) return rate;
  const xml = await (await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', { signal: AbortSignal.timeout(10_000) })).text();
  const usd = Number(/currency='USD' rate='([\d.]+)'/.exec(xml)?.[1]), date = /time='([\d-]+)'/.exec(xml)?.[1] ?? '';
  if (!(usd > 0)) throw new Error('no USD rate in ECB file');
  return (rate = { eurPerUsd: 1 / usd, date, at: Date.now() });
}

/** Discover tab: every CR campaign from the last scan, with plain reasons for the ones we can't join, and running scan/join jobs. */
function discover(db: Db) {
  const { at, campaigns } = cachedDiscover(), saved = allStreamers(), kinds = cachedKinds();
  const jobs = db.$client.prepare(`select type, payload, status, error, created_at t from jobs where type in ('campaign.discover','campaign.join') and created_at > ? order by id`)
    .all(Date.now() - DAY) as { type: string; payload: string; status: string; error: string | null; t: number }[];
  const live = (j: { status: string }) => j.status === 'queued' || j.status === 'running';
  const joinOf = (id: string) => jobs.filter((j) => j.type === 'campaign.join' && JSON.parse(j.payload).id === id).at(-1);
  const scan = jobs.filter((j) => j.type === 'campaign.discover').at(-1);
  return {
    at, scanning: Boolean(scan && live(scan)), scanError: scan?.status === 'failed' ? scan.error : null,
    campaigns: campaigns.map((c) => {
      const j = joinOf(c.id);
      return {
        id: c.id, name: c.name, org: c.organizationName ?? '', streamer: twitchOf(c), pool: c.payoutType === 'pool',
        budget: c.budgetCents / 100, left: Math.max(0, c.budgetCents - (c.metrics?.budgetSpentCents ?? 0)) / 100,
        pays: c.payouts.filter((p) => p.payoutType === 'pool' || (p.rateCents ?? 0) > 0).map((p) => ({ platform: p.platform, ratePer1k: (p.rateCents ?? 0) / 100, maxPerClip: (p.maxPayoutCents ?? 0) / 100 })),
        why: whyNot(c, saved, kinds), joining: Boolean(j && live(j)), joinError: j?.status === 'failed' ? j.error : null,
      };
    }).sort((a, b) => Number(Boolean(a.why)) - Number(Boolean(b.why)) || b.left - a.left),
  };
}

const json = (res: ServerResponse, body: unknown) => res.writeHead(body === null ? 404 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));

/** GET /api/*: true if handled. */
export function apiRoute(db: Db, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/api/overview') return json(res, overview(db)), true;
  if (url.pathname === '/api/review') return json(res, review(db)), true;
  if (url.pathname === '/api/campaigns') return json(res, allStreamers().filter((s) => s.campaign).map((s) => campaignRow(s, allPosts(db)))), true;
  if (url.pathname === '/api/discover') return json(res, discover(db)), true;
  if (url.pathname === '/api/earnings') return json(res, earnings(db)), true;
  if (url.pathname === '/api/history') return json(res, history(db)), true;
  if (url.pathname === '/api/settings') return json(res, getSettings()), true;
  if (url.pathname === '/api/accounts') return json(res, accounts(db)), true;
  if (url.pathname === '/api/ready') return json(res, ready(db)), true;
  if (url.pathname === '/api/rate') return usdRate().then((r) => json(res, r), () => json(res, rate ?? { eurPerUsd: null, date: '', at: 0 })), true;
  if (url.pathname === '/api/proposals') return json(res, proposals().map((p) => ({ ...p, pairs: p.pairs.slice(-5), allPairs: p.pairs.length, score: score(p), aa: aaBias(p) }))), true;
  const m = /^\/api\/campaigns\/([a-z0-9_]{2,25})$/.exec(url.pathname);
  if (m) return json(res, detail(db, m[1])), true;
  return false;
}
