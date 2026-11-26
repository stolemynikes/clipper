// Accounts setup (dashboard Accounts tab): platform app keys (once per platform), social accounts per campaign, "Connect" via OAuth, views and earnings.
// Secrets go straight into .env and are never rendered back or logged. The page only says "saved".
import { styleStats, styleWinner } from '../modules/learner/title-style.ts';
import { hasPostpeer } from '../modules/publisher/postpeer.ts';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { accounts, posts, streamers } from '../db/schema.ts';
import { paths } from '../env.ts';
import { logger } from '../log.ts';

const log = logger('setup');
export type Platform = 'youtube' | 'tiktok'; // platforms with our own OAuth app
export type AccountPlatform = Platform | 'instagram'; // Instagram only via PostPeer
export const LABEL: Record<AccountPlatform, string> = { youtube: 'YouTube Shorts', tiktok: 'TikTok', instagram: 'Instagram Reels' };
const port = () => Number(process.env.REVIEW_PORT || 8787);

export const APPS: Record<Platform, {
  label: string; fields: [key: string, label: string, secret: boolean][]; idParam: string; idKey: string; secretKey: string;
  auth: string; token: string; scope: string; extra: Record<string, string>; redirect: () => string | undefined; steps: string[];
}> = {
  youtube: {
    label: 'YouTube Shorts', idParam: 'client_id', idKey: 'YOUTUBE_CLIENT_ID', secretKey: 'YOUTUBE_CLIENT_SECRET',
    fields: [['YOUTUBE_CLIENT_ID', 'Client ID', false], ['YOUTUBE_CLIENT_SECRET', 'Client secret', true], ['YOUTUBE_API_KEY', 'API key (checks if a name is free)', true]],
    auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    extra: { access_type: 'offline', prompt: 'consent' }, // prompt=consent: Google only returns a refresh token on consent
    redirect: () => `http://127.0.0.1:${port()}/oauth/youtube`, // Desktop clients accept any loopback port without registering it
    steps: [
      'Use your own Google account; no new account needed. <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Create a Google Cloud project</a> (name it "Clipper"). It is free.',
      'Turn on the <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">YouTube Data API v3</a>: press <b>Enable</b>.',
      'Open the <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener">consent screen</a> (menu: APIs &amp; Services, OAuth consent screen) and press Get started. App name "Clipper", your own email. Choose <b>External</b>, not Internal: Internal only works for a company Google Workspace.',
      'Under <b>Audience</b> press <b>Publish app</b>, or you get "Error 403: access_denied" (app is still in Testing) and the login stops after 7 days.',
      'Under <a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noopener">Clients</a> press Create client, type <b>Desktop app</b>. A pop-up shows the Client ID and Client secret: paste them below and press Save keys.',
      'Press <b>Connect account</b> at the top and log in with the Google account that owns the YouTube channel for the clips (it may differ from the Cloud account). If Google says "hasn&rsquo;t verified this app": press Advanced, then Go to Clipper. That is normal for your own app.',
      'Until Google approves your app (<a href="https://support.google.com/youtube/contact/yt_api_form" target="_blank" rel="noopener">audit form</a>), uploads stay private.',
    ],
  },
  tiktok: {
    label: 'TikTok', idParam: 'client_key', idKey: 'TIKTOK_CLIENT_KEY', secretKey: 'TIKTOK_CLIENT_SECRET',
    fields: [['TIKTOK_CLIENT_KEY', 'Client key', false], ['TIKTOK_CLIENT_SECRET', 'Client secret', true], ['TIKTOK_REDIRECT_URI', 'Redirect address (https)', false]],
    auth: 'https://www.tiktok.com/v2/auth/authorize/', token: 'https://open.tiktokapis.com/v2/oauth/token/',
    scope: 'user.info.basic,video.publish,video.list', extra: {},
    redirect: () => process.env.TIKTOK_REDIRECT_URI || undefined, // TikTok requires https: tailscale serve gives one
    steps: [
      'On <a href="https://developers.tiktok.com/apps" target="_blank" rel="noopener">TikTok for Developers</a> create an app.',
      'Add the products <b>Login Kit</b> and <b>Content Posting API</b>.',
      'On the PC run <code>tailscale serve --bg 8787</code>. Your redirect address is the https address it shows plus <code>/oauth/tiktok</code>. Enter it in TikTok and below.',
      'Paste the client key and secret below, then submit the app for review. Until it is approved, posts are only visible to you.',
    ],
  },
};
const isPlatform = (p: unknown): p is Platform => p === 'youtube' || p === 'tiktok';
export const tokenKey = (id: number) => `ACCOUNT_${id}_TOKEN`;

/** Sets KEY=value in .env text: replaces the line if present, else appends. */
export function setEnv(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, () => `${key}=${value}`);
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
}
export function saveEnv(key: string, value: string) {
  writeFileSync(paths.envFile, setEnv(existsSync(paths.envFile) ? readFileSync(paths.envFile, 'utf8') : '', key, value));
  process.env[key] = value;
}
const okValue = (v: unknown): v is string => typeof v === 'string' && /^[\x21-\x7e]{1,500}$/.test(v); // printable, no spaces/newlines

/** Earnings for one post. Pool campaigns (rate 0) pay a share at the end, so 0 here. */
export function earn(views: number, ratePer1k: number, maxPerClip: number): number {
  const v = (views / 1000) * ratePer1k;
  return maxPerClip > 0 ? Math.min(v, maxPerClip) : v;
}

interface CampaignCfg { ratePer1k?: number; maxPerClip?: number }
export function accountStats(db: Db) {
  const rows = db.$client.prepare(`
    select a.id, a.platform, a.name, s.name streamer, s.config,
      (select views from stats st where st.post_id = p.id order by measured_at desc limit 1) views, p.id post
    from accounts a left join streamers s on s.id = a.streamer_id left join posts p on p.account_id = a.id order by a.id`).all() as
    { id: number; platform: AccountPlatform; name: string; streamer: string | null; config: string | null; views: number | null; post: number | null }[];
  const out = new Map<number, { id: number; platform: AccountPlatform; name: string; streamer: string | null; pool: boolean; posts: number; views: number; earned: number }>();
  for (const r of rows) {
    const c = (r.config ? (JSON.parse(r.config) as { campaign?: CampaignCfg }).campaign : undefined) ?? {};
    const a = out.get(r.id) ?? { id: r.id, platform: r.platform, name: r.name, streamer: r.streamer, pool: !c.ratePer1k, posts: 0, views: 0, earned: 0 };
    if (r.post) { a.posts++; a.views += r.views ?? 0; a.earned += earn(r.views ?? 0, c.ratePer1k ?? 0, c.maxPerClip ?? 0); }
    out.set(r.id, a);
  }
  return [...out.values()];
}

// OAuth state: random, single use, 10 minutes. Stops a forged callback from attaching someone else's account.
const pending = new Map<string, { accountId: number; platform: Platform; at: number }>();

/** Plain-words result of the title A/B test, empty until there is a winner. */
function titleTest(db: Db) {
  const st = styleStats(db), w = styleWinner(st);
  if (!w) return '';
  const [a, b] = w === 'bold' ? [st[1], st[0]] : [st[0], st[1]];
  return `Title test: ${w === 'bold' ? 'bold, curious' : 'calm'} titles get ${Math.round((a.median / Math.max(b.median, 1) - 1) * 100)}% more views. New clips now use them more often.`;
}

export const keysSet = (p: Platform) => Boolean(process.env[APPS[p].idKey] && process.env[APPS[p].secretKey]);

/** How an account posts: via PostPeer, needs PostPeer first (Instagram), or our own OAuth app. */
export const accountVia = (platform: string) =>
  platform === 'instagram' && !hasPostpeer() ? 'needs_postpeer' : platform !== 'youtube' && hasPostpeer() ? 'postpeer' : 'oauth';
// Relative everywhere: YouTube's redirect stays loopback, so a phone login ends on an error page whose address the owner pastes back (/setup/paste).
export const connectUrl = (a: { id: number; platform: string }) => `/connect/${a.id}`;

/** Query of a pasted OAuth return address, or null when it is not one of ours. */
export function pastedQuery(s: string): { platform: string; q: URLSearchParams } | null {
  try {
    const u = new URL(s.trim()), m = /\/oauth\/(youtube|tiktok)$/.exec(u.pathname);
    return m && u.searchParams.get('state') ? { platform: m[1], q: u.searchParams } : null;
  } catch { return null; }
}

/** Finish a login from the OAuth return query. Returns the message for the Accounts tab and whether it worked. */
async function finishLogin(platform: string, q: URLSearchParams): Promise<[boolean, string]> {
  const state = q.get('state') ?? '', st = pending.get(state);
  pending.delete(state);
  if (!st || st.platform !== platform || Date.now() - st.at > 10 * 60_000) return [false, 'That login link expired. Press Connect again.'];
  if (q.get('error')) return [false, 'Login was cancelled.'];
  const app = APPS[st.platform];
  const r = await fetch(app.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
    [app.idParam]: process.env[app.idKey] ?? '', client_secret: process.env[app.secretKey] ?? '', code: q.get('code') ?? '',
    grant_type: 'authorization_code', redirect_uri: app.redirect() ?? '' }) });
  const tok = await r.json().catch(() => ({})) as { refresh_token?: string; error?: string };
  if (!r.ok || !tok.refresh_token) {
    log.warn(`oauth ${st.platform} token exchange failed (${r.status} ${tok.error ?? ''})`); // never log the body: it can hold tokens
    return [false, 'Connecting failed. Check the app keys and try again.'];
  }
  saveEnv(tokenKey(st.accountId), tok.refresh_token);
  log.info(`account ${st.accountId} connected (${st.platform})`);
  return [true, 'Account connected.'];
}

/** Accounts tab setup data: which app keys are saved (never the values), campaigns to link an account to. */
export function setupInfo(db: Db) {
  return {
    hasPostpeer: hasPostpeer(), canCheckNames: Boolean(process.env.YOUTUBE_API_KEY), titleTest: titleTest(db),
    apps: (Object.keys(APPS) as Platform[]).map((p) => ({ platform: p, label: APPS[p].label, ready: keysSet(p), steps: APPS[p].steps,
      fields: APPS[p].fields.map(([key, label, secret]) => ({ key, label, secret, saved: Boolean(process.env[key]) })) })),
    campaigns: db.select().from(streamers).all().filter((s) => (s.config as { campaign?: unknown } | null)?.campaign).map((s) => ({ id: s.id, name: s.name })),
  };
}

export async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 10_000) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}
const text = (res: ServerResponse, code: number, msg: string) => res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }).end(msg);
const back = (res: ServerResponse, msg: string) => res.writeHead(302, { location: `/app/?msg=${encodeURIComponent(msg)}#/accounts` }).end();

/** Handles /setup, /connect/:id, /oauth/:platform. Returns false if the path is not ours. */
export const validHandle = (h: string) => /^[a-z0-9][a-z0-9._-]{2,29}$/.test(h);

/** YouTube handle free? Official Data API (channels.list forHandle). null = can't tell (no key, bad name, API error). */
export async function handleFree(h: string): Promise<boolean | null> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || !validHandle(h)) return null;
  const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent('@' + h)}&key=${encodeURIComponent(key)}`).catch(() => null);
  if (!r?.ok) return null;
  return !((await r.json()) as { items?: unknown[] }).items?.length;
}

export async function setupRoute(db: Db, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/setup') {
    res.writeHead(302, { location: '/app/#/accounts' }).end(); // the Accounts tab replaced this page
    return true;
  }

  const handle = /^\/setup\/handle\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && handle) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ free: await handleFree(handle[1].toLowerCase()) }));
    return true;
  }

  const conn = /^\/connect\/(\d+)$/.exec(p);
  if (req.method === 'GET' && conn) {
    const a = db.select().from(accounts).where(eq(accounts.id, Number(conn[1]))).get();
    if (!a || !isPlatform(a.platform)) return (back(res, 'Account not found.'), true);
    const app = APPS[a.platform], redirect = app.redirect(), id = process.env[app.idKey];
    if (!id || !process.env[app.secretKey] || !redirect) return (back(res, `Set up the ${app.label} app first (step list below).`), true);
    const state = randomBytes(24).toString('hex');
    pending.set(state, { accountId: a.id, platform: a.platform, at: Date.now() });
    const q = new URLSearchParams({ [app.idParam]: id, redirect_uri: redirect, response_type: 'code', scope: app.scope, state, ...app.extra });
    res.writeHead(302, { location: `${app.auth}?${q}` }).end();
    return true;
  }

  const cb = /^\/oauth\/(youtube|tiktok)$/.exec(p);
  if (req.method === 'GET' && cb) return (back(res, (await finishLogin(cb[1], url.searchParams))[1]), true);

  if (req.method !== 'POST' || req.headers['x-clipper'] !== '1') return false;
  if (p === '/setup/paste') {
    const v = (await body(req)).url, got = typeof v === 'string' ? pastedQuery(v) : null;
    if (!got) return (text(res, 400, 'That is not the address from the login page. Copy the whole address bar.'), true);
    const [ok, msg] = await finishLogin(got.platform, got.q);
    return (ok ? res.writeHead(204).end() : text(res, 400, msg), true);
  }
  const appSave = /^\/setup\/app\/(\w+)$/.exec(p);
  if (appSave) {
    if (!isPlatform(appSave[1])) return (text(res, 404, 'Unknown platform.'), true);
    const b = await body(req), allowed = APPS[appSave[1]].fields.map(([k]) => k);
    for (const [k, v] of Object.entries(b)) {
      if (!allowed.includes(k) || !okValue(v)) return (text(res, 400, 'That value does not look right. Copy it again without spaces.'), true);
      if (k.endsWith('REDIRECT_URI') && !/^https:\/\/[^/]+\/oauth\/tiktok$/.test(v)) return (text(res, 400, 'The address must start with https:// and end with /oauth/tiktok.'), true);
    }
    for (const [k, v] of Object.entries(b)) saveEnv(k, v as string);
    log.info(`${appSave[1]} app keys saved`);
    return (res.writeHead(204).end(), true);
  }
  if (p === '/setup/account') {
    const b = await body(req);
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 60) : '';
    if (!(isPlatform(b.platform) || b.platform === 'instagram') || !name) return (text(res, 400, 'Pick a platform and give it a name.'), true);
    const sid = b.streamerId ? Number(b.streamerId) : null;
    if (sid !== null && !db.select().from(streamers).where(eq(streamers.id, sid)).get()) return (text(res, 400, 'Unknown campaign.'), true);
    db.insert(accounts).values({ platform: b.platform, name, streamerId: sid }).run();
    return (res.writeHead(204).end(), true);
  }
  const del = /^\/setup\/account\/(\d+)\/delete$/.exec(p);
  if (del) {
    const id = Number(del[1]);
    if (db.select().from(posts).where(eq(posts.accountId, id)).get()) return (text(res, 409, 'This account has posts, so it stays in the list.'), true);
    db.delete(accounts).where(eq(accounts.id, id)).run();
    if (process.env[tokenKey(id)]) saveEnv(tokenKey(id), '');
    return (res.writeHead(204).end(), true);
  }
  return false;
}
