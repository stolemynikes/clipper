// Practice mode (docs/practice-plan.md): render and judge old VODs at night to learn, never review or post them.
// Runs while data/practice exists, also when Snip itself is paused. Heals itself without Claude.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { activeStreamers, clipStreamers, loadSettings } from '../../config.ts';
import { STYLES } from '../editor/subtitles.ts';
import { weeklyInsights } from '../learner/weekly.ts';
import { activeProposals, seedProposals, seedStudy } from './proposals.ts';
import type { Db } from '../../db/client.ts';
import { moments, sources } from '../../db/schema.ts';
import { paths } from '../../env.ts';
import { logger } from '../../log.ts';
import { enqueue, type Job } from '../../queue/queue.ts';
import { bark } from '../../review/review.ts';
import { getUserId, listVods, parseDuration, type Vod } from '../../twitch.ts';
import { ensureStreamer } from '../watcher/watcher.ts';

const log = logger('practice');
const DAY = 86_400_000, HOUR = 3_600_000;
const flag = () => join(paths.dataDir, 'practice');
const stateFile = () => join(paths.dataDir, 'practice-state.json');
export const isPractice = () => existsSync(flag());
export const setPractice = (on: boolean) => (on ? writeFileSync(flag(), new Date().toISOString()) : rmSync(flag(), { force: true }));

export type State = { fails: number; retried: boolean; pauseUntil: number; morning: string };
export function readState(): State {
  try { return { fails: 0, retried: false, pauseUntil: 0, morning: '', ...JSON.parse(readFileSync(stateFile(), 'utf8')) }; }
  catch { return { fails: 0, retried: false, pauseUntil: 0, morning: '' }; }
}
const save = (s: State) => writeFileSync(stateFile(), JSON.stringify(s));

/** Pure self-heal step: 3 failures in a row pause 1h once, the next 3 stop practice. A success resets both. */
export function nextState(s: State, ok: boolean, now: number): { s: State; action: 'none' | 'pause' | 'stop' } {
  if (ok) return { s: { ...s, fails: 0, retried: false }, action: 'none' };
  const fails = s.fails + 1;
  if (fails < 3) return { s: { ...s, fails }, action: 'none' };
  if (!s.retried) return { s: { ...s, fails: 0, retried: true, pauseUntil: now + HOUR }, action: 'pause' };
  return { s: { ...s, fails: 0, retried: false }, action: 'stop' };
}

function record(ok: boolean) {
  const { s, action } = nextState(readState(), ok, Date.now());
  save(s);
  if (action === 'pause') { log.warn('practice: 3 failures in a row, pausing 1 hour'); bark('Practice paused', '3 practice jobs failed in a row. Retrying in 1 hour.', { level: 'passive' }).catch(() => {}); }
  if (action === 'stop') { setPractice(false); log.error('practice stopped: failures continue after the 1 hour pause'); bark('Practice stopped', 'Practice jobs kept failing after a 1 hour pause. Turned practice off.').catch(() => {}); }
}

/** Wrap a handler so its outcome feeds the self-heal state. */
export const tracked = <P>(h: (p: P) => Promise<unknown>) => async (p: P) => { await h(p); record(true); };
/** Final failure of a practice job: count it and delete the files of a failed render. */
export function practiceFailed(job: Job) {
  const p = job.payload as { momentId?: number };
  if (job.type === 'practice.render' && p.momentId) rmSync(join(paths.dataDir, 'clips', String(p.momentId)), { recursive: true, force: true });
  log.error(`practice job ${job.id} ${job.type} failed: ${job.error ?? ''}`.slice(0, 300));
  record(false);
}

export const freeGb = () => { const s = statfsSync(paths.dataDir); return (s.bavail * s.bsize) / 1e9; };
const busy = (db: Db, types: string) => !!db.$client.prepare(`select 1 from jobs where status in ('queued','running') and type in (${types})`).get();
/** Live clips go first: practice holds while real work waits (unless Snip is paused and that work can't run anyway). */
export const liveBusy = (db: Db) => busy(db, "'vod.analyze','clip.render','clip.judge'");
export const practiceHeld = () => !isPractice() || Date.now() < readState().pauseUntil;

/** Best practice VOD: 3-14 days old (newer ones belong to the watcher), not seen before, most views first. */
export function pickVod(vods: Vod[], known: Set<string>, now: number): Vod | undefined {
  return vods.filter((v) => { const age = now - new Date(v.created_at).getTime(); return age >= 3 * DAY && age <= 14 * DAY && !known.has(v.url); })
    .sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0))[0];
}

// Stored practice windows: the raw download (src.mp4) + chat.json + tried.txt (proposal ids already tested on it),
// so a proposal added later still gets pairs when no new VOD is available.
export const KEEP_WINDOWS = 50;
const KEEP = new Set(['src.mp4', 'chat.json', 'tried.txt']);
export const tried = (dir: string) => { try { return readFileSync(join(dir, 'tried.txt'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
function windows() {
  const d = join(paths.dataDir, 'clips');
  if (!existsSync(d)) return [];
  return readdirSync(d).map((m) => join(d, m)).filter((p) => existsSync(join(p, 'src.mp4')) && existsSync(join(p, 'tried.txt')))
    .map((p) => ({ p, id: Number(basename(p)), t: statSync(join(p, 'src.mp4')).mtimeMs })).sort((a, b) => b.t - a.t);
}
/** After judging a practice clip: keep only the raw window (newest KEEP_WINDOWS), delete the renders. */
export function keepWindow(dir: string) {
  if (!existsSync(join(dir, 'tried.txt'))) return rmSync(dir, { recursive: true, force: true });
  for (const f of readdirSync(dir)) if (!KEEP.has(f)) rmSync(join(dir, f), { recursive: true, force: true });
  for (const w of windows().slice(KEEP_WINDOWS)) rmSync(w.p, { recursive: true, force: true });
}

export type StudyRow = { streamer: string; slug: string; views: number; sec: number };
export const studyUrl = (slug: string) => `https://clips.twitch.tv/${slug}`;
/** Next downloaded study clip (raw viewer clip) to practice on: active streamer, not used yet, most views first. */
export function pickStudy(rows: StudyRow[], known: Set<string>, names: Set<string>, has: (f: string) => boolean): StudyRow | undefined {
  return rows.filter((r) => names.has(r.streamer) && !known.has(studyUrl(r.slug)) && has(join(paths.dataDir, 'study', r.streamer, `${r.slug}.mp4`)))
    .sort((a, b) => b.views - a.views)[0];
}

/** No VOD: re-test a stored window on proposals it has not seen, else use a study clip. Only while proposals wait for pairs. */
function fallback(db: Db, known: Set<string>, ids: Map<string, number>) {
  const active = activeProposals().map((p) => p.id);
  if (!active.length) return false;
  const w = windows().find((x) => { const t = new Set(tried(x.p)); return active.some((id) => !t.has(id)); });
  if (w) {
    enqueue(db, 'practice.render', { momentId: w.id, practice: true, retest: true }, { maxAttempts: 2 });
    log.info(`practice: re-test moment ${w.id}`);
    return true;
  }
  let rows: StudyRow[] = [];
  try { rows = Object.values(JSON.parse(readFileSync(join(paths.dataDir, 'study-eval.json'), 'utf8'))); } catch { /* no study yet */ }
  const r = pickStudy(rows, known, new Set(ids.keys()), existsSync);
  if (!r) return false;
  const src = db.insert(sources).values({ url: studyUrl(r.slug), streamerId: ids.get(r.streamer)!, durationSec: r.sec }).onConflictDoNothing().returning().get();
  if (!src) return false;
  const m = db.insert(moments).values({ sourceId: src.id, startSec: 0, endSec: r.sec, score: 0 }).returning().get();
  const dir = join(paths.dataDir, 'clips', String(m.id));
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(paths.dataDir, 'study', r.streamer, `${r.slug}.mp4`), join(dir, 'src.mp4')); // render skips the download
  enqueue(db, 'practice.render', { momentId: m.id, practice: true }, { maxAttempts: 2 });
  log.info(`practice: study clip ${r.slug} (${r.streamer})`);
  return true;
}

/** One tick (every minute): disk guard, morning summary, and queue the next VOD when practice is idle. */
let lastNoVod = 0; // tick runs every minute: say it at most once an hour
export async function practiceTick(db: Db, now = new Date()) {
  morning(db, now);
  { const style = loadSettings().clip.captionStyle ?? 'bold'; seedProposals({ per: STYLES[style].per, style, weeklyPer: weeklyInsights().wordsPerLine }); } // idempotent by id: new seeds (e.g. length) join an existing proposals.json
  seedStudy(weeklyInsights(activeStreamers().map((s) => s.name)));
  if (practiceHeld() || busy(db, "'practice.analyze','practice.render','practice.judge'")) return;
  if (freeGb() < 100) {
    setPractice(false);
    log.error(`practice stopped: only ${freeGb().toFixed(0)} GB free on the data disk`);
    return bark('Practice stopped', `Less than 100 GB free on the data disk (${freeGb().toFixed(0)} GB).`).catch(() => {});
  }
  const known = new Set(db.select({ url: sources.url }).from(sources).all().map((r) => r.url));
  let best: { vod: Vod; streamerId: number } | undefined;
  const ids = new Map<string, number>(); // streamer name -> id, for study clips
  for (const cfg of clipStreamers(now).filter((s) => s.platform === 'twitch')) {
    try {
      const userId = await getUserId(cfg.channel);
      const streamerId = ensureStreamer(db, cfg, userId).id;
      ids.set(cfg.name, streamerId);
      const v = pickVod(await listVods(userId), known, now.getTime());
      if (v && (!best || (v.view_count ?? 0) > (best.vod.view_count ?? 0))) best = { vod: v, streamerId };
    } catch (e) { log.warn(`practice: ${cfg.name} VOD list failed: ${String(e).slice(0, 200)}`); }
  }
  if (!best && fallback(db, known, ids)) return;
  if (!best) { if (now.getTime() - lastNoVod > HOUR) { lastNoVod = now.getTime(); log.info('practice: no VOD available (3-14 days old, not done yet)'); } return; }
  const row = db.insert(sources).values({ url: best.vod.url, streamerId: best.streamerId, durationSec: parseDuration(best.vod.duration) }).onConflictDoNothing().returning().get();
  if (!row) return;
  enqueue(db, 'practice.analyze', { sourceId: row.id, vodId: best.vod.id, practice: true }, { maxAttempts: 2 });
  log.info(`practice: queued ${best.vod.url} (${best.vod.user_login}, ${best.vod.view_count ?? '?'} views)`);
}

/** 08:00 local: one Bark with last night's numbers. Sent once per day, only if practice ran. */
function morning(db: Db, now: Date) {
  const today = now.toLocaleDateString('sv-SE'), s = readState();
  if (now.getHours() !== 8 || s.morning === today) return;
  save({ ...s, morning: today });
  const since = now.getTime() - DAY;
  const n = (sql: string) => (db.$client.prepare(sql).get(since) as { n: number }).n;
  const judged = n("select count(*) n from clips where status = 'practice' and created_at > ?");
  const vods = n("select count(*) n from jobs where type = 'practice.analyze' and status = 'done' and created_at > ?");
  const failed = n("select count(*) n from jobs where type like 'practice.%' and status = 'failed' and created_at > ?");
  if (!judged && !vods && !failed) return;
  bark('Practice night', `${vods} VODs, ${judged} clips judged, ${failed} failed jobs.${isPractice() ? '' : ' Practice is off now.'}`, { level: 'passive' }).catch(() => {});
}
