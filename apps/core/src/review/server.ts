// Review page over Tailscale: plain node:http, no framework needed for a handful of routes.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Db } from '../db/client.ts';
import { logger } from '../log.ts';
import { bestScores, decide, getClip, rating, pendingClips, type ReviewRow, setPaused, status } from './review.ts';

const log = logger('review');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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
  return r.length ? r : ['Picked by the tool as a highlight'];
}

function card({ clip, moment, source, streamer }: ReviewRow, best: number) {
  const why = reasons((moment.signals ?? {}) as Record<string, number>);
  const r = rating(moment.score, best);
  return `<article id="clip-${clip.id}">
  <video src="/clip/${clip.id}.mp4" controls playsinline preload="metadata"></video>
  <div class="meta">
    <div class="head"><p class="title"><strong>${esc(streamer.name)}</strong> · ${Math.round(clip.durationSec ?? 0)} seconds</p>
    <div class="score ${r >= 8 ? 'hi' : r >= 5 ? 'mid' : 'lo'}" aria-label="Strength ${r} out of 10"><b>${r}</b>/10<span>${r >= 8 ? 'Strong' : r >= 5 ? 'Good' : 'Weak'}</span></div></div>
    <p class="sub">Why this clip: ${why.map(esc).join(' · ')}</p>
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
:root{--bg:#0b0b0f;--card:#17171c;--line:#26262e;--text:#f4f4f5;--muted:#a1a1aa;--accent:#facc15;--ok:#22c55e;--no:#ef4444}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:env(safe-area-inset-top) 16px calc(24px + env(safe-area-inset-bottom))}
header{position:sticky;top:0;background:var(--bg);padding:16px 0 12px;z-index:1;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
h1{font-size:22px;margin:0;flex:1}
.paused{color:var(--accent)!important}.stats{width:100%;color:var(--muted);font-size:14px;margin:0}
button{font:inherit;font-weight:600;min-height:48px;border-radius:12px;border:0;cursor:pointer;transition:transform .1s,opacity .2s}
button:active{transform:scale(.97)}button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.toggle{min-height:44px;padding:0 16px;background:var(--card);color:var(--text);border:1px solid var(--line)}
article{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;margin:0 auto 16px;max-width:480px;transition:opacity .25s,transform .25s}
article[aria-busy=true]{opacity:.5;pointer-events:none}article.gone{opacity:0;transform:scale(.96)}
video{display:block;width:100%;aspect-ratio:9/16;max-height:70vh;background:#000}
.head{display:flex;align-items:center;gap:12px;justify-content:space-between;margin-bottom:4px}.head .title{margin:0}
.score{flex:none;display:flex;align-items:baseline;gap:2px;padding:6px 12px;border-radius:12px;font-size:14px;color:var(--muted);background:var(--bg);border:1px solid var(--line)}
.score b{font-size:24px;line-height:1;color:var(--text)}.score span{margin-left:8px;font-weight:600}
.score.hi{border-color:var(--ok)}.score.hi span{color:var(--ok)}.score.mid{border-color:var(--accent)}.score.mid span{color:var(--accent)}.score.lo span{color:var(--muted)}
.meta{padding:12px 16px 0}.meta p{margin:0 0 4px}.sub{color:var(--muted);font-size:14px}a{color:var(--accent)}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 16px 16px}
.ok{background:var(--ok);color:#052e16}.no{background:transparent;color:var(--no);border:2px solid var(--no)}
.empty{color:var(--muted);text-align:center;padding:48px 0}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;margin:4px 0 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px;text-align:center}
.tile b{display:block;font-size:24px}.tile span{color:var(--muted);font-size:13px}
.warn{width:100%;margin:0;color:var(--no);font-size:14px}
#toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translate(-50%,16px);opacity:0;background:var(--text);color:var(--bg);padding:12px 20px;border-radius:999px;font-weight:600;transition:opacity .2s,transform .2s;pointer-events:none}
#toast.show{opacity:1;transform:translate(-50%,0)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body>
<header><h1>Clipper review</h1>
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

function route(db: Db, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(db));
  const video = /^\/clip\/(\d+)\.mp4$/.exec(url.pathname);
  if (req.method === 'GET' && video) {
    const clip = getClip(db, Number(video[1]));
    return clip && existsSync(clip.filePath) ? sendVideo(req, res, clip.filePath) : res.writeHead(404).end();
  }
  if (req.method !== 'POST' || req.headers['x-clipper'] !== '1') return res.writeHead(404).end();
  const act = /^\/clip\/(\d+)\/(approve|reject)$/.exec(url.pathname);
  if (act) return res.writeHead(decide(db, Number(act[1]), act[2] === 'approve') ? 204 : 409).end();
  if (url.pathname === '/pause' || url.pathname === '/resume') { setPaused(url.pathname === '/pause'); return res.writeHead(204).end(); }
  res.writeHead(404).end();
}

/** Bind to the Tailscale IP (REVIEW_HOST) so the page is only reachable from your own devices. */
export function startReviewServer(db: Db) {
  const host = process.env.REVIEW_HOST || '127.0.0.1';
  const port = Number(process.env.REVIEW_PORT || 8787);
  const server = createServer((req, res) => {
    try { route(db, req, res); } catch (e) { log.error('review request failed', { error: String(e) }); if (!res.headersSent) res.writeHead(500).end(); }
  });
  server.on('error', (e) => log.error('review server failed', { error: String(e) }));
  server.listen(port, host, () => log.info(`review page on http://${host}:${port}`));
  return server;
}
