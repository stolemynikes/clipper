// Learner for the "is it fun" signals: measures how well each signal predicts a good clip (AUC), and moves its
// weight a small step at a time. No human needed: runs weekly from main.ts, writes data/learned.json, reports via Bark.
// Best label wins: real views of our posts > owner Keep/Skip (auto-kept clips excluded) > viewers clipped it (proxy).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../../db/client.ts';
import { paths } from '../../env.ts';

export const LEARNED_SIGNALS = ['laughRatio', 'cheerRatio', 'speech', 'visual'] as const; // same list as judge FUN_SIGNALS
const REPORT_ONLY = ['chatRate', 'emoteScore', 'viewerClipHits', 'audioPeak']; // tuned by hand in settings.yaml
export const MIN_N = 20; // labeled clips before a weight may move
const STEP = 1, MAX_W = 5, MIN_AUC = 0.6;

export type Learned = { at: string; label: string; n: number; weights: Record<string, number>; auc: Record<string, number> };
const file = () => join(paths.dataDir, 'learned.json');
export const readLearned = (): Learned | null => (existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : null);
export const learnedWeights = (): Record<string, number> => readLearned()?.weights ?? {};

/** Chance that a random good clip scores higher than a random bad one (0.5 = coin flip). null if one class is empty. */
export function auc(scores: number[], good: boolean[]): number | null {
  const pos = scores.filter((_, i) => good[i]), neg = scores.filter((_, i) => !good[i]);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Target weight from AUC (0.6 -> 2, 0.75 -> 5); move at most STEP per run so one odd week can't swing it. */
export function nextWeight(current: number, a: number | null, n: number): number {
  if (a === null || n < MIN_N) return current;
  const target = a >= MIN_AUC ? Math.min(MAX_W, (a - 0.5) * 20) : 0;
  return Math.round((current + Math.max(-STEP, Math.min(STEP, target - current))) * 100) / 100;
}

type Row = { signals: string | null; status: string; views: number | null };
export function labeled(rows: Row[]): { label: string; items: { s: Record<string, number>; good: boolean }[] } {
  const parsed = rows.map((r) => ({ ...r, s: JSON.parse(r.signals ?? '{}') as Record<string, number> }));
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
  const viewed = parsed.filter((r) => r.views !== null);
  if (viewed.length >= MIN_N) {
    const m = med(viewed.map((r) => r.views!));
    return { label: 'views of our posts', items: viewed.map((r) => ({ s: r.s, good: r.views! > m })) };
  }
  const decided = parsed.filter((r) => ['approved', 'posted', 'rejected'].includes(r.status) && !r.s.autoKept);
  if (decided.length >= MIN_N) return { label: 'owner Keep/Skip', items: decided.map((r) => ({ s: r.s, good: r.status !== 'rejected' })) };
  const m = med(parsed.map((r) => r.s.viewerClipHits ?? 0));
  return { label: 'viewers clipped it (proxy)', items: parsed.map((r) => ({ s: r.s, good: (r.s.viewerClipHits ?? 0) > m })) };
}

/** One learning step over all judged clips. Returns the new state and plain-language changes. */
export function learnStep(rows: Row[], prev: Learned | null, now = new Date()): { next: Learned; changes: string[] } {
  const judged = rows.filter((r) => LEARNED_SIGNALS.some((k) => r.signals?.includes(`"${k}"`)));
  const { label, items } = labeled(judged);
  const aucs: Record<string, number> = {}, weights: Record<string, number> = {}, changes: string[] = [];
  for (const k of [...LEARNED_SIGNALS, ...REPORT_ONLY]) {
    if (label.startsWith('viewers') && k === 'viewerClipHits') continue; // it is the label itself
    const has = items.filter((x) => typeof x.s[k] === 'number');
    const a = auc(has.map((x) => x.s[k]), has.map((x) => x.good));
    if (a !== null) aucs[k] = Math.round(a * 100) / 100;
    if (!(LEARNED_SIGNALS as readonly string[]).includes(k)) continue;
    const before = prev?.weights[k] ?? 0;
    weights[k] = nextWeight(before, a, has.length);
    if (weights[k] !== before) changes.push(`${k} ${before} -> ${weights[k]} (AUC ${aucs[k]}, ${has.length} clips)`);
  }
  return { next: { at: now.toISOString(), label, n: items.length, weights, auc: aucs }, changes };
}

export function learnOnce(db: Db, now = new Date()) {
  const rows = db.$client.prepare(`
    select m.signals, c.status, (select max(st.views) from posts p join stats st on st.post_id = p.id where p.clip_id = c.id) views
    from clips c join moments m on m.id = c.moment_id`).all() as Row[];
  const r = learnStep(rows, readLearned(), now);
  writeFileSync(file(), JSON.stringify(r.next, null, 2));
  return r;
}

export const learnDue = (now = new Date()) => { const l = readLearned(); return !l || now.getTime() - new Date(l.at).getTime() >= 7 * 86_400_000; };
