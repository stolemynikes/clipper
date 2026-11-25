// Review page over Tailscale: plain node:http, no framework needed for a handful of routes.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/client.ts';
import { logger } from '../log.ts';
import { setupRoute } from './setup.ts';
import { campaignsRoute } from './campaigns.ts';
import { apiRoute } from './api.ts';
import { CSS, esc } from './style.ts';
import { bestScores, decide, getClip, rating, pendingClips, type ReviewRow, setOff, setPaused, status } from './review.ts';

const log = logger('review');

/** Parses an HTTP Range header; iOS Safari only plays video when ranges work. */
export function parseRange(h: string | undefined, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

function sendVideo(req: IncomingMessage, res: ServerResponse, file: string) {
  const size = statSync(file).size;
  const r = parseRange(req.headers.range, size);
  const head = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
  if (!r) return createReadStream(file).pipe(res.writeHead(200, { ...head, 'content-length': size }));
  createReadStream(file, r).pipe(res.writeHead(206, { ...head, 'content-length': r.end - r.start + 1, 'content-range': `bytes ${r.start}-${r.end}/${size}` }));
}

/** Plain-language reasons; raw signals stay hidden from non-technical reviewers. */
export function reasons(s: Record<string, number>): string[] {
  const r: string[] = [];
  if ((s.viewerClipHits ?? 0) > 0) r.push(`${s.viewerClipHits} viewer${s.viewerClipHits === 1 ? '' : 's'} clipped this moment`);
  if ((s.chatRate ?? 0) >= 2) r.push('Chat went wild');
  else if ((s.chatRate ?? 0) >= 1) r.push('Chat got busy');
  if ((s.emoteScore ?? 0) >= 1) r.push('Lots of laughing and hype emotes');
  if (s.website) r.push('Mostly a website on screen, so rated lower');
  return r.length ? r : ['Picked by the tool as a highlight'];
}

function card({ clip, moment, source, streamer }: ReviewRow, best: number) {
  const why = reasons((moment.signals ?? {}) as Record<string, number>);
  const r = rating(moment.score, best, (moment.signals as Record<string, number> | null)?.layoutPenalty ?? 0);
  return `<article id="clip-${clip.id}">
  <video src="/clip/${clip.id}.mp4" controls playsinline preload="metadata"></video>
  <div class="meta">
    <div class="head"><p class="title"><strong>${esc(streamer.name)}</strong> · ${Math.round(clip.durationSec ?? 0)} seconds</p>
    <div class="score ${r >= 8 ? 'hi' : r >= 5 ? 'mid' : 'lo'}" aria-label="Strength ${r} out of 10"><b>${r}</b>/10<span>${r >= 8 ? 'Strong' : r >= 5 ? 'Good' : 'Weak'}</span></div></div>
    ${clip.title ? `<p class="sub">Title: <strong>${esc(clip.title)}</strong>${clip.hook ? ` · On screen: ${esc(clip.hook)}` : ''}</p>` : ''}
    <p class="sub">Why this clip: ${why.map(esc).join(' · ')}</p>
    ${((clip.compliance?.warnings ?? []) as string[]).map((w) => `<p class="note">Note: ${esc(w)}</p>`).join('')}
    <p class="sub"><a href="${esc(source.url)}?t=${Math.floor(moment.startSec)}s" target="_blank" rel="noopener">Watch in the full stream</a></p>
  </div>
  <div class="actions">
    <button class="no" onclick="act(${clip.id},'reject',this)">✕ Skip</button>
    <button class="ok" onclick="act(${clip.id},'approve',this)">✓ Keep</button>
  </div>
</article>`;
}

function page(db: Db) {
  const st = status(db);
  const n = (rows: { status: string; n: number }[], ...want: string[]) => rows.filter((r) => want.includes(r.status)).reduce((a, r) => a + r.n, 0);
  const rows = pendingClips(db), best = bestScores(db);
  const working = n(st.jobs, 'queued', 'running'), problems = n(st.jobs, 'failed');
  const line = st.paused ? 'Paused. No new clips are made until you press Start.'
    : working ? 'Working. New clips are being made in the background.' : 'Waiting for a new stream.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Clipper review</title>
<style>
${CSS}</style></head><body>
<header><h1>Clipper review</h1><a href="/setup">Accounts</a><a href="/campaigns">Campaigns</a>
<button class="toggle" onclick="post('/${st.paused ? 'resume' : 'pause'}').then(()=>location.reload())">${st.paused ? 'Start' : 'Pause'}</button>
<p class="stats${st.paused ? ' paused' : ''}" role="status">${line}</p>
<div class="tiles"><div class="tile"><b>${rows.length}</b><span>To review</span></div>
<div class="tile"><b>${n(st.clips, 'approved', 'posted')}</b><span>Kept</span></div>
<div class="tile"><b>${n(st.clips, 'rejected')}</b><span>Skipped</span></div></div>
${problems ? `<p class="warn">${problems} task${problems === 1 ? '' : 's'} failed. You got a push with details.</p>` : ''}</header>
<main>${rows.map((r) => card(r, best.get(r.source.id) ?? 0)).join('\n') || '<p class="empty">All done! You will get a push on your phone when a new clip is ready.</p>'}</main>
<div id="toast" role="status" aria-live="polite"></div>
<script>
// Custom header: a cross-site form/fetch cannot send it without a CORS preflight, which this server never allows.
const post = (u) => fetch(u, { method: 'POST', headers: { 'x-clipper': '1' } });
let tid;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tid); tid = setTimeout(() => t.classList.remove('show'), 3000); }
async function act(id, a, btn) {
  const card = btn.closest('article');
  card.setAttribute('aria-busy', 'true');
  const r = await post('/clip/' + id + '/' + a).catch(() => null);
  if (!r || !r.ok) { card.removeAttribute('aria-busy'); toast(r && r.status === 409 ? 'This clip was already handled.' : 'That did not work. Is the PC on? Try again.'); return; }
  toast(a === 'approve' ? 'Kept! Saved to your approved clips.' : 'Skipped.');
  card.classList.add('gone');
  setTimeout(() => { card.remove(); if (!document.querySelector('article')) setTimeout(() => location.reload(), 1500); }, 250);
}
</script></body></html>`;
}

const DIST = fileURLToPath(new URL('../../../dashboard/dist/', import.meta.url));
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

/** The React dashboard (npm run dashboard:build). Hashed assets cache forever, index.html never. */
function sendApp(res: ServerResponse, pathname: string) {
  const rel = pathname.replace(/^\/app\/?/, '') || 'index.html';
  const file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
  const asset = rel.startsWith('assets/');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': asset ? 'public, max-age=31536000, immutable' : 'no-store' });
  createReadStream(file).pipe(res);
}

function route(db: Db, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && (url.pathname === '/app' || url.pathname.startsWith('/app/'))) return sendApp(res, url.pathname);
  // The dashboard replaces the old page once built; /classic keeps the old one reachable.
  if (req.method === 'GET' && url.pathname === '/' && existsSync(join(DIST, 'index.html'))) return res.writeHead(302, { location: '/app/' }).end();
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/classic')) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(db));
  const video = /^\/clip\/(\d+)\.mp4$/.exec(url.pathname);
  if (req.method === 'GET' && video) {
    const clip = getClip(db, Number(video[1]));
    return clip && existsSync(clip.filePath) ? sendVideo(req, res, clip.filePath) : res.writeHead(404).end();
  }
  if (req.method !== 'POST' || req.headers['x-clipper'] !== '1') return res.writeHead(404).end();
  const act = /^\/clip\/(\d+)\/(approve|reject)$/.exec(url.pathname);
  if (act) return res.writeHead(decide(db, Number(act[1]), act[2] === 'approve') ? 204 : 409).end();
  if (url.pathname === '/pause' || url.pathname === '/resume') { setPaused(url.pathname === '/pause'); return res.writeHead(204).end(); }
  const tog = /^\/toggle\/(study|learn)\/(on|off)$/.exec(url.pathname);
  if (tog) { setOff(tog[1] as 'study' | 'learn', tog[2] === 'off'); return res.writeHead(204).end(); }
  res.writeHead(404).end();
}

/** Bind to the Tailscale IP (REVIEW_HOST) so the page is only reachable from your own devices. */
export function startReviewServer(db: Db) {
  const host = process.env.REVIEW_HOST || '127.0.0.1';
  const port = Number(process.env.REVIEW_PORT || 8787);
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (/^\/(setup|connect|oauth)(\/|$)/.test(url.pathname) && await setupRoute(db, req, res, url)) return;
      if (url.pathname.startsWith('/api/') && apiRoute(db, req, res, url)) return;
      if (/^\/campaigns(\/|$)/.test(url.pathname) && await campaignsRoute(db, req, res, url)) return;
      route(db, req, res);
    } catch (e) { log.error('review request failed', { error: String(e) }); if (!res.headersSent) res.writeHead(500).end(); }
  };
  const listen = (h: string) => {
    const s = createServer(handler);
    s.on('error', (e) => log.error('review server failed', { error: String(e) }));
    s.listen(port, h, () => log.info(`review page on http://${h}:${port}`));
    return s;
  };
  // Loopback too: Google's Desktop OAuth redirect must be 127.0.0.1, and tailscale serve proxies to it.
  if (host !== '127.0.0.1') listen('127.0.0.1');
  return listen(host);
}
