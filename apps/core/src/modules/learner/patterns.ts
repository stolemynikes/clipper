// Why Shorts work, per kind of clip: the local LLM labels each studied Short from a fixed list, plus measured features.
// Top Shorts and the best quarter of a channel's own Shorts count as 'top', that channel's worst quarter as 'flop'.
// Features that show up much more often in top than flop become plain lines in the judge prompt.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from '../../env.ts';

export type Kind = 'gaming' | 'talk' | 'music';
export const CATEGORIES: Record<Kind, { label: string; query: string; category?: string; top: number }> = {
  gaming: { label: 'Streams and gaming', query: 'twitch stream', category: '20', top: 25 },
  talk: { label: 'Podcasts and shows', query: 'podcast', top: 12 },
  music: { label: 'Music', query: 'live performance', category: '10', top: 12 },
};
export const LABELS = ['punchline', 'hot take', 'argument', 'surprising fact', 'emotional story', 'advice', 'big reaction', 'skill play', 'fail or rage', 'performance', 'other'] as const;

export type Row = { id: string; kind: Kind; group: 'top' | 'flop'; at: string; views: number; labels: string[]; question: boolean; hook: boolean; laugh: boolean; cheer: boolean; fast: boolean; laughScore?: number; cheerScore?: number }; // raw YAMNet peaks, to tune the 0.3 cut later
const FEATURES: Record<string, string> = { question: 'asks the viewer a question', hook: 'someone talks in the first 3 seconds', laugh: 'audible laughter', cheer: 'cheering or applause', fast: 'fast talking (3+ words a second)' };
export const NEED = 15; // per group, before a pattern counts
const MIN_SUPPORT = 5;
const Z_MIN = 1.645;
const KEEP_DAYS = 60, MAX_ROWS = 400;

const file = () => join(paths.dataDir, 'study', 'patterns.json');
const nowFile = () => join(paths.dataDir, 'study', 'learning-now.json');

export function readRows(): Row[] {
  try { return JSON.parse(readFileSync(file(), 'utf8')) as Row[]; } catch { return []; }
}
/** Add rows, newest wins per id+group; drop rows older than 60 days and cap each kind. */
export function saveRows(add: Row[], now = Date.now()) {
  const byKey = new Map(readRows().map((r) => [`${r.kind}:${r.id}`, r]));
  for (const r of add) byKey.set(`${r.kind}:${r.id}`, r);
  const fresh = [...byKey.values()].filter((r) => now - Date.parse(r.at) < KEEP_DAYS * 86_400_000).sort((a, b) => b.at.localeCompare(a.at));
  const kept = (Object.keys(CATEGORIES) as Kind[]).flatMap((k) => fresh.filter((r) => r.kind === k).slice(0, MAX_ROWS));
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(kept));
}
export const studied = (kind: Kind) => new Set(readRows().filter((r) => r.kind === kind).map((r) => r.id));

/** Feature names of one row: its labels plus the measured ones that are true. */
const traits = (r: Row) => [...r.labels.filter((l) => l !== 'other'), ...Object.keys(FEATURES).filter((f) => r[f as keyof Row] === true)];
export const describe = (t: string) => t.split(' + ').map((x) => FEATURES[x] ?? x).join(' + ');

export type Pattern = { trait: string; top: number; flop: number; lift: number; n: number; z: number };
/** Share of top vs flop rows per trait and per pair of traits. Ready once both groups have NEED rows. */
export function patterns(rows: Row[]) {
  const top = rows.filter((r) => r.group === 'top'), flop = rows.filter((r) => r.group === 'flop');
  const count = (rs: Row[]) => {
    const m = new Map<string, number>();
    for (const r of rs) {
      const t = [...new Set(traits(r))].sort();
      for (let i = 0; i < t.length; i++) { m.set(t[i], (m.get(t[i]) ?? 0) + 1); for (let j = i + 1; j < t.length; j++) m.set(`${t[i]} + ${t[j]}`, (m.get(`${t[i]} + ${t[j]}`) ?? 0) + 1); }
    }
    return m;
  };
  const ct = count(top), cf = count(flop);
  const list: Pattern[] = [...new Set([...ct.keys(), ...cf.keys()])].map((trait) => {
    const a = ct.get(trait) ?? 0, b = cf.get(trait) ?? 0;
    const p = a / (top.length || 1), q = b / (flop.length || 1);
    // two-proportion z-test: how sure the difference is not chance
    const pool = (a + b) / ((top.length + flop.length) || 1), se = Math.sqrt(pool * (1 - pool) * (1 / (top.length || 1) + 1 / (flop.length || 1)));
    return { trait, top: +p.toFixed(2), flop: +q.toFixed(2), lift: +(p - q).toFixed(2), n: a + b, z: se ? +((p - q) / se).toFixed(2) : 0 };
  }).filter((x) => x.n >= MIN_SUPPORT);
  return { top: top.length, flop: flop.length, ready: top.length >= NEED && flop.length >= NEED, list: list.sort((x, y) => y.lift - x.lift) };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** Plain lines: up to 3 traits that clearly help, up to 2 that clearly hurt. Empty until there is enough data. */
export function learnedLines(rows: Row[]) {
  const p = patterns(rows);
  if (!p.ready) return { works: [] as string[], weak: [] as string[] };
  const solo = new Map(p.list.filter((x) => !x.trait.includes(' + ')).map((x) => [x.trait, x.lift]));
  // a combo only counts when it beats both of its parts alone; else it repeats the stronger part
  // |z| >= 1.645: p < 0.1 two-sided; below that the difference may be chance
  const list = p.list.filter((x) => Math.abs(x.z) >= Z_MIN).filter((x) => !x.trait.includes(' + ') || x.trait.split(' + ').every((t) => Math.abs(x.lift) >= Math.abs(solo.get(t) ?? 0) + 0.05));
  const line = (x: Pattern) => `${describe(x.trait)} (in ${pct(x.top)} of top Shorts, ${pct(x.flop)} of weak ones)`;
  return { works: list.filter((x) => x.lift >= 0.15).slice(0, 3).map(line), weak: list.filter((x) => x.lift <= -0.15).reverse().slice(0, 2).map(line) };
}

/** Extra prompt text for the judge; empty string when nothing is learned yet. */
export function judgeHint(kind: Kind | undefined) {
  if (!kind) return '';
  const { works, weak } = learnedLines(readRows().filter((r) => r.kind === kind));
  if (!works.length && !weak.length) return '';
  return `\nWhat this week's popular Shorts of this kind have, compared with weak Shorts from the same channels:${works.map((l) => `\n- more often: ${l}`).join('')}${weak.map((l) => `\n- less often: ${l}`).join('')}\nUse this as a hint only; judge the clip itself.`;
}

/** What the study is doing right now, for the Learning page. */
export type Now = { what: string; kind?: Kind; step: string; done: number; total: number; at: string };
export function setNow(n: Omit<Now, 'at'> | null) {
  if (!n) return rmSync(nowFile(), { force: true });
  mkdirSync(dirname(nowFile()), { recursive: true });
  writeFileSync(nowFile(), JSON.stringify({ ...n, at: new Date().toISOString() }));
}
export function readNow(now = Date.now()): Now | null {
  try { const n = JSON.parse(readFileSync(nowFile(), 'utf8')) as Now; return now - Date.parse(n.at) < 2 * 3_600_000 ? n : null; } catch { return null; } // stale: the job died
}
