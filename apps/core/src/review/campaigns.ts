// Campaigns page: paste a brief, Ollama reads it, the owner checks the form, saves to streamers.yaml.
// "On" first runs the study (progress bar); "Make clips" unlocks when the study is done.
import { readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { campaignOpen, loadSettings, type StreamerConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import { paths } from '../env.ts';
import { logger } from '../log.ts';
import { campaignNotes, viewsToPay } from '../modules/compliance/campaign-notes.ts';
import { readProgress, type Progress } from '../modules/learner/study.ts';
import { enqueue } from '../queue/queue.ts';
import { accountStats, earn } from './setup.ts';
import { CSS, esc } from './style.ts';

const log = logger('campaigns');
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const file = () => join(paths.configDir, 'streamers.yaml');
type Campaign = NonNullable<StreamerConfig['campaign']>;
const PLATFORMS = ['tiktok', 'youtube', 'instagram', 'x'] as const;

/** Hard rule: no gambling campaigns. Checked on the brief text, not only on what the model says. */
const GAMBLING = /\b(casinos?|gambl\w*|betting|bets?|slots?|1win|vavada|stake\.com|roulette|poker|gattouz|sportsbooks?|blackjack|jackpot)\b/i;
export const isGambling = (text: string) => GAMBLING.test(text);

export type Extract = {
  name: string; channel: string; tag: string; ratePer1k: number; maxPerClip: number; pool: number; minViews: number; totalViews: number; minPayout: number;
  budgetLeft: number; endsAt: string; platforms: string[]; hashtags: string[]; accountNote: string; contentRules: string; disclosure: boolean; gambling: boolean;
};
const NUMS = ['ratePer1k', 'maxPerClip', 'pool', 'minViews', 'totalViews', 'minPayout', 'budgetLeft'] as const;

/** Every number written in the text ("7,500", "$7.5K", "1M", "0.75"), so model output can be checked against it. */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?(?![\w])/g)) {
    const n = Number(m[1].replace(/,/g, '')) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1);
    if (Number.isFinite(n)) out.add(Math.round(n * 100) / 100);
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Fields the model filled but the text does not show: the form marks them "check this". 0 / empty = not stated, fine. */
export function unverified(x: Extract, text: string): string[] {
  const nums = numbersIn(text), low = text.toLowerCase(), bad: string[] = [];
  for (const k of NUMS) if (x[k] > 0 && !nums.has(Math.round(x[k] * 100) / 100)) bad.push(k);
  if (x.endsAt) {
    const d = new Date(x.endsAt);
    const day = d.getUTCDate(), mon = MONTHS[d.getUTCMonth()];
    const found = low.includes(x.endsAt) || new RegExp(`\\b${mon}\\w*\\.?\\s+${day}\\b|\\b${day}(st|nd|rd|th)?\\s+(of\\s+)?${mon}`).test(low)
      || new RegExp(`\\b${d.getUTCMonth() + 1}/${day}\\b`).test(low);
    if (Number.isNaN(d.getTime()) || !found) bad.push('endsAt');
  }
  if (x.channel && !low.includes(x.channel.toLowerCase())) bad.push('channel');
  return bad;
}

/** Ollama (local) reads the brief. Low temperature, JSON schema; numbers are checked against the text afterwards. */
export async function extract(text: string, url: string): Promise<{ fields: Extract; check: string[] }> {
  const props = {
    name: { type: 'string' }, channel: { type: 'string' }, tag: { type: 'string' },
    ...Object.fromEntries(NUMS.map((k) => [k, { type: 'number' }])),
    // Booleans and a plain string, not arrays: at temperature 0 gemma repeated array items until the token cap.
    endsAt: { type: 'string' }, ...Object.fromEntries(PLATFORMS.map((p) => [p, { type: 'boolean' }])),
    hashtags: { type: 'string' }, accountNote: { type: 'string' }, contentRules: { type: 'string' }, disclosure: { type: 'boolean' }, gambling: { type: 'boolean' },
  };
  const prompt = `Read this clipping campaign brief and fill the fields. Use ONLY facts written in the text. If something is not written, use 0 or "".
- name: the streamer's name, lowercase, no spaces. channel: their Twitch login if written, else the name.
- tag: the @handle clips must tag, if written.
- ratePer1k: dollars per 1,000 views (0 for a pool campaign). maxPerClip: max dollars per clip. pool: total pool dollars if it is a pool.
- minViews: views ONE clip needs before it counts or pays. totalViews: total views a clipper needs over all clips to get any pool share (e.g. "700,000 views to share the pool"). minPayout: minimum payout in dollars. budgetLeft: dollars left in the budget if written.
- endsAt: end date as YYYY-MM-DD, only if written.
- tiktok, youtube, instagram, x: true if views on that platform count (YouTube Shorts = youtube).
- hashtags: the hashtags captions must use, separated by spaces, else "".
- accountNote: one short sentence on account rules (e.g. "account may only post GTA 6 content"), else "".
- contentRules: what the brief requires or forbids IN the clip itself (e.g. "Kai must be the main focus", "no logos", "no hate clips"), separated by " | ", else "". Not posting, payment or account rules.
- disclosure: true only if the brief itself says posts must carry #ad or be marked as paid, sponsored or FTC-disclosed, else false.
- gambling: true if it promotes a casino, betting, slots or any gambling.
Campaign page: ${url || 'not given'}

Brief:
${text.slice(0, 12_000)}`;
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: loadSettings().titles?.model ?? 'gemma4:12b', stream: false, think: false, keep_alive: '2m',
      format: { type: 'object', properties: props, required: Object.keys(props) }, options: { temperature: 0, num_predict: 900 },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Ollama failed: ${r.status}`);
  const raw = JSON.parse(((await r.json()) as { message: { content: string } }).message.content) as Omit<Extract, 'platforms' | 'hashtags'> & Record<string, unknown>;
  const fields: Extract = { ...raw, platforms: PLATFORMS.filter((p) => raw[p] === true),
    hashtags: String(raw.hashtags ?? '').split(/[\s,]+/).filter(Boolean).slice(0, 10), name: String(raw.name ?? '').toLowerCase().replace(/[^a-z0-9_]/g, ''), channel: (/twitch\.tv\/(\w+)/i.exec(text)?.[1] ?? String(raw.channel ?? '').replace(/^.*twitch\.tv\//i, '')).toLowerCase().replace(/[^a-z0-9_]/g, '') };
  fields.gambling = Boolean(raw.gambling) || isGambling(text);
  return { fields, check: unverified(fields, text) };
}

/** Rate campaigns: what one clip earns at the median views of other clippers' Shorts. Pool: null (a share, unknown). */
export const expectedPerClip = (c: Campaign, medianViews: number | undefined) =>
  c.ratePer1k > 0 && medianViews ? earn(medianViews, c.ratePer1k, c.maxPerClip) : null;

/** Owner-facing account rules that code cannot check by itself. */
export function accountWarnings(c: Campaign): string[] {
  const p = (Array.isArray(c.rules?.platforms) ? c.rules.platforms : []).map(String);
  const w: string[] = [];
  if (typeof c.rules?.accountNote === 'string' && c.rules.accountNote) w.push(`Account rule: ${c.rules.accountNote}`);
  if (p.includes('instagram')) w.push('Instagram: the account must be Business or Creator, and Collab posts do not count.');
  if (p.includes('tiktok') || p.includes('x')) w.push('TikTok and X: clips about politics are blocked automatically.');
  return w;
}

/** Validates a form post and turns it into a streamers.yaml entry. Throws a plain-words error. */
export function toEntry(b: Record<string, unknown>): StreamerConfig {
  const str = (k: string) => String(b[k] ?? '').trim();
  const num = (k: string) => { const n = Number(b[k] || 0); if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a number, 0 or more`); return n; };
  const list = (k: string) => (Array.isArray(b[k]) ? (b[k] as unknown[]).map(String) : str(k).split(/[\s,]+/)).filter(Boolean);
  const name = str('name').toLowerCase(), channel = (str('channel') || name).toLowerCase();
  if (!/^[a-z0-9_]{2,25}$/.test(name) || !/^[a-z0-9_]{2,25}$/.test(channel)) throw new Error('Name and channel: letters, numbers and _ only');
  if (isGambling([str('brief'), name, str('accountNote'), str('tag')].join(' ')) || b.gambling === true || b.gambling === 'true') throw new Error('Gambling campaign: not allowed (hard rule).');
  const endsAt = str('endsAt');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endsAt) || Number.isNaN(Date.parse(endsAt))) throw new Error('End date: pick a date');
  const platforms = list('platforms').map((p) => p.toLowerCase()).filter((p) => (PLATFORMS as readonly string[]).includes(p));
  if (!platforms.length) throw new Error('Pick at least one platform');
  const ratePer1k = num('ratePer1k'), pool = num('pool');
  if (!ratePer1k && !pool) throw new Error('Fill in the rate per 1K views or the pool');
  const url = str('url');
  if (url && !/^https:\/\/[^\s"'<>]+$/.test(url)) throw new Error('Campaign link must start with https://');
  const rules: Record<string, unknown> = { platforms, hashtags: list('hashtags').map((h) => (h.startsWith('#') ? h : `#${h}`)) };
  for (const k of ['minViews', 'totalViews', 'minPayout'] as const) if (num(k)) rules[k] = num(k);
  if (str('accountNote')) rules.accountNote = str('accountNote').slice(0, 200);
  const notes = str('contentRules').split('|').map((n) => n.trim()).filter(Boolean).slice(0, 8);
  if (notes.length) rules.notes = notes; // per-streamer content rules the judge checks
  const tag = str('tag') || `@${name}`;
  const campaign: Campaign = { platform: 'content_rewards', ...(url ? { url } : {}), ratePer1k, maxPerClip: num('maxPerClip'), endsAt, rules,
    disclosure: b.disclosure === true || b.disclosure === 'true' }; // off unless the brief asks for #ad
  if (pool) campaign.pool = pool;
  if (num('budgetLeft')) campaign.budgetLeft = num('budgetLeft');
  return { name, platform: 'twitch', channel, tag: tag.startsWith('@') ? tag : `@${tag}`, stage: 'study', enabled: false, campaign } as StreamerConfig;
}

// streamers.yaml through parseDocument, so the owner's comments stay.
const loadDoc = () => parseDocument(readFileSync(file(), 'utf8'));
export const allStreamers = (): StreamerConfig[] => (loadDoc().toJS()?.streamers ?? []) as StreamerConfig[];
export function update(name: string, patch: Partial<StreamerConfig> | StreamerConfig, create = false) {
  const doc = loadDoc(), i = allStreamers().findIndex((s) => s.name === name);
  if (i < 0 && !create) throw new Error('Campaign not found');
  if (i < 0) (doc.get('streamers') as { add: (n: unknown) => void }).add(doc.createNode(patch));
  else for (const [k, v] of Object.entries(patch)) doc.setIn(['streamers', i, k], doc.createNode(v));
  writeFileSync(file(), doc.toString());
}

export function campaignStatus(s: StreamerConfig, p: Progress | null): { label: string; cls: string } {
  if (!campaignOpen(s.campaign!)) return { label: 'Ended', cls: '' };
  if (s.enabled === false) return { label: 'Off', cls: '' };
  if (s.stage === 'study') return p?.finished ? { label: 'Study done', cls: 'on' } : p?.error ? { label: 'Study failed', cls: 'warn' } : { label: 'Studying', cls: 'warn' };
  return { label: 'Making clips', cls: 'on' };
}

function card(s: StreamerConfig, earned: { views: number; earned: number }) {
  const c = s.campaign!, p = readProgress(s.name), st = campaignStatus(s, p);
  const { facts, warnings } = campaignNotes(c);
  const exp = expectedPerClip(c, p?.medianShortViews);
  const plats = (Array.isArray(c.rules?.platforms) ? c.rules.platforms : []).map(String);
  const on = s.enabled !== false && campaignOpen(c);
  const studying = on && s.stage === 'study' && !p?.finished;
  const pct = p?.total ? Math.round((p.done / p.total) * 100) : 0;
  const expLine = exp !== null ? `About $${exp.toFixed(2)} per clip (other clippers' Shorts get ~${p!.medianShortViews!.toLocaleString('en-US')} views)`
    : c.ratePer1k > 0 ? 'Per-clip estimate after the study' : `Share of the $${(c.pool ?? 0).toLocaleString('en-US')} pool, split by views at the end`;
  return `<article class="pad camp" data-name="${esc(s.name)}" data-vtp="${viewsToPay(c)}" data-rate="${c.ratePer1k}" data-end="${esc(c.endsAt)}" data-plats="${esc(plats.join(' '))}" data-studying="${studying}">
<div class="head"><h2>${esc(s.name)}</h2><span class="pill ${st.cls}">${st.label}</span></div>
<ul class="facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}<li>${esc(expLine)}</li>
<li>Your result: ${earned.views.toLocaleString('en-US')} views, $${earned.earned.toFixed(2)} earned${c.ratePer1k ? '' : ' (pool pays at the end)'}</li></ul>
${[...warnings, ...accountWarnings(c)].map((w) => `<p class="warn" role="note">${esc(w)}</p>`).join('')}
${on && s.stage === 'study' ? `<div class="study"><label for="pg-${esc(s.name)}">${p?.finished ? 'Study done: we know what works.' : p?.error ? `Study failed: ${esc(p.error)}` : 'Study: watching the most-viewed clips first'}</label>
<progress id="pg-${esc(s.name)}" max="100" value="${p?.finished ? 100 : pct}">${pct}%</progress><span class="sub" data-count>${p ? `${p.done} of ${p.total}` : 'Waiting in line'}</span></div>` : ''}
<div class="actions">${campaignOpen(c) ? `<button class="${on ? 'no' : 'ok'}" onclick="act('${esc(s.name)}','${on ? 'off' : 'on'}',this)">${on ? 'Turn off' : 'Turn on'}</button>` : ''}
${on && s.stage === 'study' ? `<button class="ok" ${p?.finished ? '' : 'disabled aria-disabled="true"'} onclick="act('${esc(s.name)}','clips',this)">Make clips</button>` : ''}
${c.url ? `<a class="btn toggle" href="${esc(c.url)}" target="_blank" rel="noopener">Campaign page</a>` : ''}</div></article>`;
}

function page(db: Db) {
  const list = allStreamers().filter((s) => s.campaign);
  const stats = accountStats(db);
  const per = (n: string) => stats.filter((a) => a.streamer === n).reduce((t, a) => ({ views: t.views + a.views, earned: t.earned + a.earned }), { views: 0, earned: 0 });
  const total = stats.reduce((t, a) => t + a.earned, 0);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Campaigns</title><style>${CSS}
main{max-width:480px;margin:0 auto}h2{font-size:18px;margin:0}.pad{padding:16px}.pad .actions{padding:12px 0 0;grid-template-columns:repeat(auto-fit,minmax(120px,1fr))}
section>h2{margin:24px 0 8px;font-size:20px}.pill{font-size:13px;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.pill.on{border-color:var(--ok);color:var(--ok)}.pill.warn{border-color:#f59e0b;color:#f59e0b}.facts{margin:8px 0 0;padding-left:20px}.facts li{margin:0 0 4px}
p.warn{margin:8px 0 0;padding:8px 12px;border-left:3px solid #f59e0b;background:var(--bg);border-radius:8px;color:var(--text)}
label{display:block;font-size:14px;color:var(--muted);margin:8px 0}input,select,textarea{display:block;width:100%;margin-top:4px;min-height:48px;padding:8px 12px;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:12px}
textarea{min-height:160px;resize:vertical}.check input{border-color:#f59e0b}.check::after{content:'Not found in the text: check this';display:block;color:#f59e0b;font-size:13px;margin-top:4px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.btn{display:flex;align-items:center;justify-content:center;min-height:48px;border-radius:12px;font-weight:600;text-decoration:none}
button[disabled]{opacity:.4;cursor:not-allowed}form .ok{width:100%;margin-top:8px}.filters{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
progress{width:100%;height:10px;border-radius:999px;overflow:hidden;appearance:none;background:var(--bg);border:0}progress::-webkit-progress-bar{background:var(--bg)}
progress::-webkit-progress-value{background:var(--ok);transition:width .4s}progress::-moz-progress-bar{background:var(--ok)}.study{margin-top:12px}
.checks{display:flex;flex-wrap:wrap;gap:8px}.checks label{display:flex;align-items:center;gap:6px;min-height:44px;margin:0;padding:0 12px;border:1px solid var(--line);border-radius:999px;color:var(--text)}.checks input{width:auto;min-height:0;margin:0}
</style></head><body>
<header><h1>Campaigns</h1><a href="/">Review</a><a href="/setup">Accounts</a>
<div class="tiles"><div class="tile"><b>${list.filter((s) => s.enabled !== false && campaignOpen(s.campaign!)).length}</b><span>On</span></div><div class="tile"><b>${list.length}</b><span>Saved</span></div><div class="tile"><b>$${total.toFixed(2)}</b><span>Earned</span></div></div></header>
<main>
<section><h2>Your campaigns</h2>
<div class="filters"><label>Sort<select id="sort" onchange="order()"><option value="vtp">Fewest views to first pay</option><option value="rate">Most $ per 1K</option><option value="end">Ends soonest</option></select></label>
<label>Platform<select id="plat" onchange="order()"><option value="">All</option>${PLATFORMS.map((p) => `<option>${p}</option>`).join('')}</select></label></div>
<div id="list">${list.map((s) => card(s, per(s.name))).join('\n') || '<p class="empty">No campaigns yet. Add one below.</p>'}</div></section>
<section><h2>Add a campaign</h2><article class="pad">
<form id="read" onsubmit="return readBrief(event)">
<label>Campaign link<input name="url" type="url" placeholder="https://contentrewards.com/c/campaigns/..."></label>
<label>Brief (copy all text from the campaign page)<textarea name="text" required maxlength="40000"></textarea></label>
<button class="ok">Read the brief</button></form>
<form id="save" hidden onsubmit="return saveCamp(event)">
<p class="sub">Read by the local AI. Fields with an orange line were not found in the text: check them.</p>
<div class="row"><label data-k="name">Streamer<input name="name" required></label><label data-k="channel">Twitch channel<input name="channel" required></label></div>
<div class="row"><label data-k="ratePer1k">$ per 1K views<input name="ratePer1k" type="number" step="0.01" min="0"></label><label data-k="maxPerClip">Max $ per clip<input name="maxPerClip" type="number" step="0.01" min="0"></label></div>
<div class="row"><label data-k="pool">Pool $<input name="pool" type="number" min="0"></label><label data-k="budgetLeft">Budget left $<input name="budgetLeft" type="number" min="0"></label></div>
<div class="row"><label data-k="minViews">Views per clip to count<input name="minViews" type="number" min="0"></label><label data-k="totalViews">Total views to share pool<input name="totalViews" type="number" min="0"></label><label data-k="minPayout">Min payout $<input name="minPayout" type="number" step="0.01" min="0"></label></div>
<label data-k="endsAt">Ends on<input name="endsAt" type="date" required></label>
<fieldset class="checks" style="border:0;padding:0;margin:8px 0"><legend class="sub">Views count on</legend>${PLATFORMS.map((p) => `<label><input type="checkbox" name="platforms" value="${p}">${p}</label>`).join('')}</fieldset>
<label>Hashtags<input name="hashtags" placeholder="#Name"></label><label>Tag<input name="tag" placeholder="@name"></label>
<label>Account rule<input name="accountNote" maxlength="200"></label>
<label>Content rules<input name="contentRules" maxlength="600" placeholder="Kai must be the main focus | no logos"></label>
<div class="checks"><label><input type="checkbox" name="disclosure">Mark posts as paid</label></div>
<input type="hidden" name="url"><input type="hidden" name="brief">
<button class="ok">Save (starts off)</button></form></article></section></main>
<div id="toast" role="status" aria-live="polite"></div>
<script>
const send = (u, body) => fetch(u, { method: 'POST', headers: { 'x-clipper': '1', 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
let tid;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tid); tid = setTimeout(() => t.classList.remove('show'), 3500); }
function order() {
  const k = document.getElementById('sort').value, pl = document.getElementById('plat').value, list = document.getElementById('list');
  const cards = [...list.querySelectorAll('.camp')];
  const v = (c) => k === 'rate' ? -Number(c.dataset.rate) : k === 'end' ? Date.parse(c.dataset.end) : Number(c.dataset.vtp);
  cards.sort((a, b) => v(a) - v(b)).forEach((c) => { c.hidden = pl && !c.dataset.plats.split(' ').includes(pl); list.append(c); });
}
async function act(name, what, btn) {
  btn.disabled = true;
  const r = await send('/campaigns/' + encodeURIComponent(name) + '/' + what).catch(() => null);
  if (r && r.ok) { toast({ on: 'On. The study starts first.', off: 'Off.', clips: 'Clips will be made from new VODs.' }[what]); setTimeout(() => location.reload(), 700); }
  else { btn.disabled = false; toast(r ? await r.text() : 'That did not work. Is the PC on?'); }
}
async function readBrief(e) {
  e.preventDefault(); const f = e.target, b = f.querySelector('button'); b.disabled = true; b.textContent = 'Reading... (up to a minute)';
  const r = await send('/campaigns/extract', { text: f.text.value, url: f.url.value }).catch(() => null);
  b.disabled = false; b.textContent = 'Read the brief';
  if (!r || !r.ok) return toast(r ? await r.text() : 'That did not work. Is the PC on?'), false;
  const { fields, check } = await r.json(), s = document.getElementById('save');
  if (fields.gambling) toast('This looks like a gambling campaign: it cannot be saved.');
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'platforms') s.querySelectorAll('[name=platforms]').forEach((i) => { i.checked = v.includes(i.value); });
    else if (k === 'disclosure') s.disclosure.checked = v === true;
    else if (s[k] && s[k].type !== 'checkbox') s[k].value = Array.isArray(v) ? v.join(' ') : (v || '');
  }
  s.querySelectorAll('[data-k]').forEach((l) => l.classList.toggle('check', check.includes(l.dataset.k)));
  s.url.value = f.url.value; s.brief.value = f.text.value; s.hidden = false; s.name.focus(); return false;
}
async function saveCamp(e) {
  e.preventDefault(); const f = e.target, d = Object.fromEntries(new FormData(f));
  d.platforms = [...f.querySelectorAll('[name=platforms]:checked')].map((i) => i.value); d.disclosure = f.disclosure.checked;
  const r = await send('/campaigns/save', d).catch(() => null);
  if (r && r.ok) { toast('Saved. Turn it on to start the study.'); setTimeout(() => location.reload(), 900); } else toast(r ? await r.text() : 'That did not work. Is the PC on?');
  return false;
}
// Live progress while a study runs; reload once it is done so the Make clips button unlocks.
if (document.querySelector('[data-studying=true]')) setInterval(async () => {
  const p = await fetch('/campaigns/progress').then((r) => r.json()).catch(() => null); if (!p) return;
  for (const c of document.querySelectorAll('[data-studying=true]')) {
    const x = p[c.dataset.name]; if (!x) continue;
    if (x.finished || x.error) return location.reload();
    c.querySelector('progress').value = x.total ? Math.round(x.done / x.total * 100) : 0;
    c.querySelector('[data-count]').textContent = x.done + ' of ' + x.total;
  }
}, 3000);
order();
</script></body></html>`;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 100_000) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}
const text = (res: ServerResponse, code: number, msg: string) => res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }).end(msg);

/** Handles /campaigns*. Returns false if the path is not ours. */
export async function campaignsRoute(db: Db, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/campaigns') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(db));
    return true;
  }
  if (req.method === 'GET' && p === '/campaigns/progress') {
    const out = Object.fromEntries(allStreamers().map((s) => [s.name, readProgress(s.name)]));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(out));
    return true;
  }
  if (req.method !== 'POST' || req.headers['x-clipper'] !== '1') return false;
  try {
    if (p === '/campaigns/extract') {
      const b = await body(req);
      const t = String(b.text ?? '');
      if (t.trim().length < 40) return (text(res, 400, 'Paste the whole brief first.'), true);
      const out = await extract(t, String(b.url ?? '')).catch((e) => { log.error('extract failed', { error: String(e) }); return null; });
      if (!out) return (text(res, 503, 'The local AI did not answer. Is Ollama running?'), true);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      return true;
    }
    if (p === '/campaigns/save') {
      const e = toEntry(await body(req));
      if (!campaignOpen(e.campaign!)) return (text(res, 400, 'This campaign has already ended.'), true);
      if (allStreamers().some((s) => s.name === e.name)) return (text(res, 409, `${e.name} is already saved.`), true);
      update(e.name, e, true);
      log.info(`campaign saved: ${e.name}`);
      return (res.writeHead(204).end(), true);
    }
    const m = /^\/campaigns\/([a-z0-9_]+)\/(on|off|clips)$/.exec(p);
    if (m) {
      const [, name, what] = m, s = allStreamers().find((x) => x.name === name);
      if (!s?.campaign) return (text(res, 404, 'Campaign not found.'), true);
      if (what === 'off') update(name, { enabled: false });
      if (what === 'on') {
        if (!campaignOpen(s.campaign)) return (text(res, 400, 'This campaign has ended.'), true);
        const studied = readProgress(name)?.finished;
        update(name, { enabled: true, ...(s.stage === 'study' || !studied ? { stage: s.stage ?? 'clips' } : {}) });
        if (s.stage === 'study' && !studied) enqueue(db, 'campaign.study', { name }, { maxAttempts: 2 });
      }
      if (what === 'clips') {
        if (!readProgress(name)?.finished) return (text(res, 409, 'Wait until the study is done.'), true);
        update(name, { stage: 'clips' });
      }
      return (res.writeHead(204).end(), true);
    }
  } catch (e) {
    return (text(res, 400, (e as Error).message.slice(0, 200)), true);
  }
  return false;
}
