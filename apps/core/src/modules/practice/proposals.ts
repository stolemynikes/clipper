// Proposals (docs/practice-plan.md, phase 2): one editing change each, tested at night by A/B on practice clips.
// The pairwise judge sees the same moment rendered with the current template and with the proposal, in random order.
// Live clips use only approved changes (tweaks()). Stored in data/proposals.json: small, read by worker and dashboard.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../env.ts';
import type { CaptionStyle } from '../editor/subtitles.ts';

/** What a proposal changes. Render knobs the frame judge can see, plus metadata from the study (untested). */
export type Change = {
  wordsPerChunk?: number; captionShift?: number; captionStyle?: CaptionStyle; titleExamples?: string[];
  leadSec?: number; maxLen?: number; // length: build-up before the peak, longest cut (campaign maxSec still caps)
};
/** Length changes move the cut: judged on the two transcripts, not on frames. */
export const isLength = (c: Change) => c.leadSec !== undefined || c.maxLen !== undefined;
export type Pair = { clipId: number; newFirst: boolean; pick: 'new' | 'old' | 'same'; why: string; at: number };
export type Proposal = {
  id: string; title: string; why: string; change: Change;
  status: 'testing' | 'ready' | 'approved' | 'rejected'; created: number; decided?: number;
  untested?: boolean; // from study, no A/B: gemma cannot judge metadata. Real views after posting measure it.
  pairs: Pair[]; aa: { pick: 0 | 1 | 2 }[]; // A/A control: same clip twice, pick 1 or 2 should be ~50/50 (0 = no difference, the right answer)
  frames: { clipId: number; old: string; new: string }[]; // small jpgs in data/proposals/<id>/ for the report
};

export const MIN_PAIRS = 20, MAX_PAIRS = 24;
const file = () => join(paths.dataDir, 'proposals.json');
export const proposalDir = (id: string) => join(paths.dataDir, 'proposals', id);
export function proposals(): Proposal[] {
  try { return JSON.parse(readFileSync(file(), 'utf8')); } catch { return []; }
}
export const saveProposals = (ps: Proposal[]) => writeFileSync(file(), JSON.stringify(ps, null, 1));
/** Proposals tested on the next practice clip: all of them at once (one render of the moment, one encode per variant). */
export const activeProposals = (max = 6) => proposals().filter((p) => p.status === 'testing' && !p.untested).sort((a, b) => a.created - b.created).slice(0, max);

/** Approved changes in approval order; later ones win. The live render uses only these. */
export const tweaks = (ps = proposals()): Change =>
  Object.assign({}, ...ps.filter((p) => p.status === 'approved').sort((a, b) => (a.decided ?? 0) - (b.decided ?? 0)).map((p) => p.change));

/** Wins of the proposal (a "same" counts half) with a 95% Wilson interval. null below MIN_PAIRS. */
export function score(p: Pick<Proposal, 'pairs'>) {
  const n = p.pairs.length;
  if (n < MIN_PAIRS) return null;
  const wins = p.pairs.reduce((a, x) => a + (x.pick === 'new' ? 1 : x.pick === 'same' ? 0.5 : 0), 0);
  const ph = wins / n, z = 1.96, d = 1 + z * z / n;
  const mid = (ph + z * z / (2 * n)) / d, half = (z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))) / d;
  return { wins, n, share: ph, low: Math.max(0, mid - half), high: Math.min(1, mid + half) };
}

/** Position bias from the A/A control: share of "first" among real picks. Flagged when clearly off 50%. */
export function aaBias(p: Pick<Proposal, 'aa'>) {
  const picks = p.aa.filter((a) => a.pick), first = picks.filter((a) => a.pick === 1).length;
  const n = picks.length;
  return { n: p.aa.length, sameShare: p.aa.length ? (p.aa.length - n) / p.aa.length : null, firstShare: n ? first / n : null, biased: n >= 4 && Math.abs(first / n - 0.5) > 0.25 };
}

/** Store one judged pair (or A/A check); move to "ready" at MAX_PAIRS. */
export function recordPair(id: string, r: { pair?: Pair; aa?: 0 | 1 | 2; frames?: Proposal['frames'][number] }) {
  const ps = proposals(), p = ps.find((x) => x.id === id);
  if (!p) return;
  if (r.pair) p.pairs.push(r.pair);
  if (r.aa !== undefined) p.aa.push({ pick: r.aa });
  if (r.frames) p.frames.push(r.frames);
  if (p.status === 'testing' && p.pairs.length >= MAX_PAIRS) p.status = 'ready';
  saveProposals(ps);
}

export function decide(id: string, approve: boolean) {
  const ps = proposals(), p = ps.find((x) => x.id === id);
  if (!p) return false;
  p.status = approve ? 'approved' : 'rejected'; p.decided = Date.now();
  saveProposals(ps);
  return true;
}

/** Starting proposals, one change each. Added once; ids are stable so a re-seed never duplicates. */
export function seedProposals(cur: { per: number; style: CaptionStyle; weeklyPer: number | null }) {
  const ps = proposals();
  const add = (p: Omit<Proposal, 'status' | 'created' | 'pairs' | 'aa' | 'frames'>) => { if (!ps.some((x) => x.id === p.id)) ps.push({ ...p, status: 'testing', created: Date.now(), pairs: [], aa: [], frames: [] }); };
  // The weekly study used to change live captions on its own; now it is a proposal like the rest.
  if (cur.weeklyPer && cur.weeklyPer !== cur.per) add({ id: `words-${cur.weeklyPer}`, title: `${cur.weeklyPer} words per caption line`, why: `Most top gaming Shorts this week show about ${cur.weeklyPer} words per line (weekly study). Now ${cur.per}.`, change: { wordsPerChunk: cur.weeklyPer } });
  const fewer = Math.max(1, cur.per - 1);
  if (fewer !== cur.weeklyPer && fewer !== cur.per) add({ id: `words-${fewer}`, title: `${fewer} words per caption line`, why: `Fewer words at once are faster to read on a phone. Now ${cur.per}.`, change: { wordsPerChunk: fewer } });
  add({ id: 'captions-lower', title: 'Captions 150 px lower', why: 'Lower captions cover less of the face and the action; still above the app buttons.', change: { captionShift: 150 } });
  // Length (trim.ts: lead 12s, target 12-26s). Judged on transcripts: does the cut keep the build-up and end on the payoff?
  add({ id: 'lead-6', title: 'Shorter build-up (6 s before the peak)', why: 'Gets to the point faster; most viewers decide in the first seconds. Now 12 s.', change: { leadSec: 6 } });
  add({ id: 'lead-18', title: 'Longer build-up (18 s before the peak)', why: 'More context, so the joke lands for someone who never saw the stream. Now 12 s.', change: { leadSec: 18 } });
  add({ id: 'max-20', title: 'Clips at most 20 s', why: 'Nov 24 study: clips under 20 s beat the streamer median 54% vs ~33% for longer. Now up to 26 s.', change: { maxLen: 20 } });
  for (const s of (['pop', 'clean'] as CaptionStyle[]).filter((x) => x !== cur.style)) add({ id: `style-${s}`, title: `Caption style "${s}"`, why: `Test the ${s} caption look against the current "${cur.style}".`, change: { captionStyle: s } });
  saveProposals(ps);
}

/** Metadata from the weekly study becomes an untested proposal, once per study run; live titles never follow the study on their own. */
export function seedStudy(study: { at: string | null; titles: string[] }) {
  if (!study.at || !study.titles.length) return;
  const id = `titles-${study.at.slice(0, 10)}`, ps = proposals();
  if (ps.some((x) => x.id === id)) return;
  ps.push({ id, title: "Title style of this week's top Shorts", why: `The title writer copies the style (not the content) of the ${study.titles.length} most-viewed gaming Shorts of the weekly study.`,
    change: { titleExamples: study.titles }, untested: true, status: 'ready', created: Date.now(), pairs: [], aa: [], frames: [] });
  saveProposals(ps);
}

export const hasProposals = () => existsSync(file());
