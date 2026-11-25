// Practice mode (docs/practice-plan.md): render and judge old VODs at night to learn, never review or post them.
// Runs while data/practice exists, also when Snip itself is paused. Heals itself without Claude.
import { existsSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clipStreamers, loadSettings } from '../../config.ts';
import { STYLES } from '../editor/subtitles.ts';
import { weeklyInsights } from '../learner/weekly.ts';
import { hasProposals, seedProposals } from './proposals.ts';
import type { Db } from '../../db/client.ts';
import { sources } from '../../db/schema.ts';
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

/** One tick (every minute): disk guard, morning summary, and queue the next VOD when practice is idle. */
export async function practiceTick(db: Db, now = new Date()) {
  morning(db, now);
  if (!hasProposals()) { const style = loadSettings().clip.captionStyle ?? 'bold'; seedProposals({ per: STYLES[style].per, style, weeklyPer: weeklyInsights().wordsPerLine }); }
  if (practiceHeld() || busy(db, "'practice.analyze','practice.render','practice.judge'")) return;
  if (freeGb() < 100) {
    setPractice(false);
    log.error(`practice stopped: only ${freeGb().toFixed(0)} GB free on the data disk`);
    return bark('Practice stopped', `Less than 100 GB free on the data disk (${freeGb().toFixed(0)} GB).`).catch(() => {});
  }
  const known = new Set(db.select({ url: sources.url }).from(sources).all().map((r) => r.url));
  let best: { vod: Vod; streamerId: number } | undefined;
  for (const cfg of clipStreamers(now).filter((s) => s.platform === 'twitch')) {
    try {
      const userId = await getUserId(cfg.channel);
      const v = pickVod(await listVods(userId), known, now.getTime());
      if (v && (!best || (v.view_count ?? 0) > (best.vod.view_count ?? 0))) best = { vod: v, streamerId: ensureStreamer(db, cfg, userId).id };
    } catch (e) { log.warn(`practice: ${cfg.name} VOD list failed: ${String(e).slice(0, 200)}`); }
  }
  if (!best) return;
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
