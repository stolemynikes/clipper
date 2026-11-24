// Accounts page: platform app keys (once per platform), social accounts per campaign, "Connect" via OAuth, views and earnings.
// Secrets go straight into .env and are never rendered back or logged. The page only says "saved".
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { accounts, posts, streamers } from '../db/schema.ts';
import { paths } from '../env.ts';
import { logger } from '../log.ts';
import { CSS, esc } from './style.ts';

const log = logger('setup');
export type Platform = 'youtube' | 'tiktok';
const port = () => Number(process.env.REVIEW_PORT || 8787);

export const APPS: Record<Platform, {
  label: string; fields: [key: string, label: string, secret: boolean][]; idParam: string; idKey: string; secretKey: string;
  auth: string; token: string; scope: string; extra: Record<string, string>; redirect: () => string | undefined; steps: string[];
}> = {
  youtube: {
    label: 'YouTube Shorts', idParam: 'client_id', idKey: 'YOUTUBE_CLIENT_ID', secretKey: 'YOUTUBE_CLIENT_SECRET',
    fields: [['YOUTUBE_CLIENT_ID', 'Client ID', false], ['YOUTUBE_CLIENT_SECRET', 'Client secret', true]],
    auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    extra: { access_type: 'offline', prompt: 'consent' }, // prompt=consent: Google only returns a refresh token on consent
    redirect: () => `http://127.0.0.1:${port()}/oauth/youtube`, // Desktop clients accept any loopback port without registering it
    steps: [
      '<a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Create a Google Cloud project</a> (name it "Clipper").',
      'Turn on the <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">YouTube Data API v3</a>.',
      'Fill in the <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener">consent screen</a> (External). Under Audience press "Publish app", or the login stops working after 7 days.',
      '<a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noopener">Create a client</a> of type <b>Desktop app</b> and paste the ID and secret below.',
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
    { id: number; platform: Platform; name: string; streamer: string | null; config: string | null; views: number | null; post: number | null }[];
  const out = new Map<number, { id: number; platform: Platform; name: string; streamer: string | null; pool: boolean; posts: number; views: number; earned: number }>();
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

const fmt = (n: number) => n.toLocaleString('en-US');
const money = (n: number) => `$${n.toFixed(2)}`;

function page(db: Db, msg: string | null) {
  const list = accountStats(db);
  const camps = db.select().from(streamers).all().filter((s) => (s.config as { campaign?: unknown } | null)?.campaign);
  const views = list.reduce((a, r) => a + r.views, 0), earned = list.reduce((a, r) => a + r.earned, 0);
  const keysSet = (p: Platform) => Boolean(process.env[APPS[p].idKey] && process.env[APPS[p].secretKey]);
  const app = (p: Platform) => {
    const a = APPS[p];
    return `<article class="pad"><div class="head"><h2>${a.label}</h2><span class="pill ${keysSet(p) ? 'on' : ''}">${keysSet(p) ? 'Ready' : 'Not set up'}</span></div>
<details${keysSet(p) ? '' : ' open'}><summary>How to set up (one time)</summary><ol>${a.steps.map((s) => `<li>${s}</li>`).join('')}</ol></details>
<form onsubmit="return saveApp(event,'${p}')">${a.fields.map(([k, l, secret]) => `<label>${l}<input name="${k}" type="${secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false"
 placeholder="${process.env[k] ? 'Saved. Paste to replace' : 'Paste here'}"></label>`).join('')}<button class="ok">Save</button></form></article>`;
  };
  const acc = (r: (typeof list)[number]) => {
    const linked = Boolean(process.env[tokenKey(r.id)]);
    // YouTube's redirect is loopback: the whole login must run in a browser on the PC itself.
    const connect = r.platform === 'youtube' ? `http://127.0.0.1:${port()}/connect/${r.id}` : `/connect/${r.id}`;
    return `<article class="pad"><div class="head"><h2>${esc(r.name)}</h2><span class="pill ${linked ? 'on' : ''}">${linked ? 'Connected' : 'Not connected'}</span></div>
<p class="sub">${APPS[r.platform].label} · ${r.streamer ? `campaign: ${esc(r.streamer)}` : 'no campaign'}</p>
<div class="tiles"><div class="tile"><b>${fmt(r.posts)}</b><span>Posts</span></div><div class="tile"><b>${fmt(r.views)}</b><span>Views</span></div>
<div class="tile"><b>${r.pool ? 'Pool' : money(r.earned)}</b><span>${r.pool ? 'Paid at the end' : 'Earned'}</span></div></div>
<div class="actions"><a class="btn ok${keysSet(r.platform) ? '' : ' off'}" href="${connect}">${linked ? 'Connect again' : 'Connect account'}</a>
<button class="no" onclick="removeAcc(${r.id},this)">Remove</button></div>
${!keysSet(r.platform) ? `<p class="sub">Set up the ${APPS[r.platform].label} app below first.</p>`
    : r.platform === 'youtube' && !linked ? '<p class="sub">Press Connect on the PC itself, not on your phone.</p>' : ''}</article>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Accounts</title>
<style>${CSS}
main{max-width:480px;margin:0 auto}h2{font-size:18px;margin:0}.pad{padding:16px}.pad .tiles{margin:12px 0 0}.pad .actions{padding:12px 0 0}
section>h2{margin:24px 0 8px;font-size:20px}
.pill{font-size:13px;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}.pill.on{border-color:var(--ok);color:var(--ok)}
details{margin:8px 0}summary{cursor:pointer;color:var(--accent);min-height:44px;display:flex;align-items:center}ol{padding-left:20px;margin:0}li{margin:0 0 6px}
code{background:var(--bg);padding:1px 6px;border-radius:6px;font-size:14px}
label{display:block;font-size:14px;color:var(--muted);margin:8px 0}input,select{display:block;width:100%;margin-top:4px;min-height:48px;padding:0 12px;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:12px}
input:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:1px}
form .ok{width:100%;margin-top:8px}.btn{display:flex;align-items:center;justify-content:center;min-height:48px;border-radius:12px;font-weight:600;text-decoration:none}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 8px}.chips .idea{display:flex;align-items:center;gap:2px}.chips a{min-height:44px;display:flex;align-items:center;padding:0 8px;font-size:14px}.chips button{min-height:44px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit;font-size:14px}
.btn.off{opacity:.4;pointer-events:none}.msg{background:var(--card);border:1px solid var(--accent);border-radius:12px;padding:12px 16px;margin:8px 0}
</style></head><body>
<header><h1>Accounts</h1><a href="/">Back to review</a>
<div class="tiles"><div class="tile"><b>${list.length}</b><span>Accounts</span></div><div class="tile"><b>${fmt(views)}</b><span>Views</span></div><div class="tile"><b>${money(earned)}</b><span>Earned</span></div></div></header>
<main>${msg ? `<p class="msg" role="status">${esc(msg)}</p>` : ''}
<section><h2>Your accounts</h2>${list.map(acc).join('\n') || '<p class="empty">No accounts yet. Add one below.</p>'}
<article class="pad"><h2>Add an account</h2><form id="add" onsubmit="return addAcc(event)" onchange="ideas()">
<label>Platform<select name="platform"><option value="tiktok">TikTok</option><option value="youtube">YouTube Shorts</option></select></label>
<label>Campaign<select name="streamerId">${camps.map((s) => `<option value="${s.id}" data-name="${esc(s.name)}">${esc(s.name)}</option>`).join('')}<option value="" data-name="">None</option></select></label>
<label>Name (only for you)<input name="name" required maxlength="60"></label>
<p class="sub">Username ideas (tap to copy). Tap Check first: if the page says the account does not exist, the name is free. Pick one that says it is a clip page, not the streamer.</p>
<div class="chips" id="ideas"></div>
<button class="ok">Add</button></form></article></section>
<section><h2>Platform apps</h2><p class="sub">Needed once per platform, before you can connect accounts.</p>${(['tiktok', 'youtube'] as const).map(app).join('\n')}</section></main>
<div id="toast" role="status" aria-live="polite"></div>
<script>
const send = (u, body) => fetch(u, { method: 'POST', headers: { 'x-clipper': '1', 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
let tid;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tid); tid = setTimeout(() => t.classList.remove('show'), 3000); }
async function done(r, okMsg) { if (r && r.ok) { toast(okMsg); setTimeout(() => location.replace('/setup'), 700); } else toast(r ? await r.text() : 'That did not work. Is the PC on?'); }
async function saveApp(e, p) {
  e.preventDefault(); const body = {};
  for (const i of e.target.querySelectorAll('input')) if (i.value.trim()) body[i.name] = i.value.trim();
  if (!Object.keys(body).length) { toast('Paste at least one value.'); return false; }
  done(await send('/setup/app/' + p, body).catch(() => null), 'Saved.'); return false;
}
// Fan/clip page names: platforms ban accounts that pose as the streamer, so every idea says "clips".
function ideas() {
  const f = document.getElementById('add'), o = f.streamerId.selectedOptions[0], n = (o && o.dataset.name || 'stream').toLowerCase().replace(/[^a-z0-9]/g, '');
  const plat = f.platform.value === 'youtube' ? 'YouTube' : 'TikTok';
  if (!f.name.dataset.touched) f.name.value = (o && o.dataset.name ? o.dataset.name.charAt(0).toUpperCase() + o.dataset.name.slice(1) + ' clips ' : 'Clips ') + plat;
  // Less common combos first: short ones like "<name>clips" are usually taken already.
  const list = [n + '.clips.hq', n + 'clipzone', n + '.moments.tv', 'daily' + n + 'clips', n + 'clips.vault', n + '_highlights_hq'];
  const prof = f.platform.value === 'youtube' ? 'https://www.youtube.com/@' : 'https://www.tiktok.com/@';
  document.getElementById('ideas').replaceChildren(...list.map((t) => {
    const w = document.createElement('span'); w.className = 'idea';
    const b = document.createElement('button'); b.type = 'button'; b.textContent = '@' + t;
    // clipboard API only exists on https/localhost: over the Tailscale IP the toast shows the name instead.
    b.onclick = () => (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Copied ' + t), () => toast(t));
    // No official API says if a handle is free, and scraping is not allowed: the user opens the profile page and looks.
    const a = document.createElement('a'); a.href = prof + t; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Check';
    a.setAttribute('aria-label', 'Check if @' + t + ' is free');
    w.append(b, a); return w; }));
}
document.addEventListener('DOMContentLoaded', () => { const f = document.getElementById('add'); f.name.oninput = () => { f.name.dataset.touched = '1'; }; ideas(); });
async function addAcc(e) { e.preventDefault(); done(await send('/setup/account', Object.fromEntries(new FormData(e.target))).catch(() => null), 'Account added.'); return false; }
async function removeAcc(id, btn) { if (!confirm('Remove this account? Its posts stay counted.')) return; done(await send('/setup/account/' + id + '/delete').catch(() => null), 'Removed.'); }
</script></body></html>`;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 10_000) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}
const text = (res: ServerResponse, code: number, msg: string) => res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }).end(msg);
const back = (res: ServerResponse, msg: string) => res.writeHead(302, { location: `/setup?msg=${encodeURIComponent(msg)}` }).end();

/** Handles /setup, /connect/:id, /oauth/:platform. Returns false if the path is not ours. */
export async function setupRoute(db: Db, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/setup') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(db, url.searchParams.get('msg')));
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
  if (req.method === 'GET' && cb) {
    const st = pending.get(url.searchParams.get('state') ?? '');
    pending.delete(url.searchParams.get('state') ?? '');
    if (!st || st.platform !== cb[1] || Date.now() - st.at > 10 * 60_000) return (back(res, 'That login link expired. Press Connect again.'), true);
    if (url.searchParams.get('error')) return (back(res, 'Login was cancelled.'), true);
    const app = APPS[st.platform];
    const r = await fetch(app.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      [app.idParam]: process.env[app.idKey] ?? '', client_secret: process.env[app.secretKey] ?? '', code: url.searchParams.get('code') ?? '',
      grant_type: 'authorization_code', redirect_uri: app.redirect() ?? '' }) });
    const tok = await r.json().catch(() => ({})) as { refresh_token?: string; error?: string };
    if (!r.ok || !tok.refresh_token) {
      log.warn(`oauth ${st.platform} token exchange failed (${r.status} ${tok.error ?? ''})`); // never log the body: it can hold tokens
      return (back(res, 'Connecting failed. Check the app keys and try again.'), true);
    }
    saveEnv(tokenKey(st.accountId), tok.refresh_token);
    log.info(`account ${st.accountId} connected (${st.platform})`);
    return (back(res, 'Account connected.'), true);
  }

  if (req.method !== 'POST' || req.headers['x-clipper'] !== '1') return false;
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
    if (!isPlatform(b.platform) || !name) return (text(res, 400, 'Pick a platform and give it a name.'), true);
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
