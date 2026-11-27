// Proposals (docs/practice-plan.md, phase 2): one editing change each, tested at night by A/B on practice clips.
// The pairwise judge sees the same moment rendered with the current template and with the proposal, in random order.
// Live clips use only approved changes (tweaks()). Stored in data/proposals.json: small, read by worker and dashboard.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../env.ts';
import type { Rect } from '../editor/render.ts';
import type { CaptionStyle } from '../editor/subtitles.ts';
import type { StreamerConfig } from '../../config.ts';
import type { Kind } from '../learner/patterns.ts';

/** What a proposal changes. Render knobs the frame judge can see, plus metadata from the study (untested). */
export type Change = {
  wordsPerChunk?: number; captionShift?: number; captionStyle?: CaptionStyle; titleExamples?: string[];
  leadSec?: number; maxLen?: number;
  duckVol?: number; deadAirSec?: number; lufs?: number; // sound: the frame judge cannot hear, so these come from the sound study (untested)
  hashtags?: string[]; titleMax?: number; // metadata from the weekly study: added after the required tags, never instead of them
  gameCrop?: Record<string, Rect>; // per streamer: game part under the cam (cam scene only); other streamers' clips skip the test
  funWeights?: Record<string, number>; // fun-signal weights for the score; tested on the study clips with real views, not by the judge // length: build-up before the peak, longest cut (campaign maxSec still caps)
};
/** Length changes move the cut: judged on the two transcripts, not on frames. */
export const isLength = (c: Change) => c.leadSec !== undefined || c.maxLen !== undefined;
export type Pair = { clipId: number; newFirst: boolean; pick: 'new' | 'old' | 'same'; why: string; at: number };
export type Proposal = {
  id: string; title: string; why: string; change: Change;
  kind?: Kind; // which clips it is tested on and changes; unset = gaming (all early proposals were stream tests)
  status: 'testing' | 'ready' | 'approved' | 'rejected'; created: number; decided?: number;
  untested?: boolean; // from study, no A/B: gemma cannot judge metadata. Real views after posting measure it.
  evidence?: string; // untested by the judge but checked another way (e.g. weights on real views), shown instead of "not tested"
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
export const kindOf = (p: Pick<Proposal, 'kind'>): Kind => p.kind ?? 'gaming';
/** Kind of clip a campaign makes: streams = gaming, footage music = music, other footage (podcast, show, product) = talk. */
export const kindFor = (cfg: Pick<StreamerConfig, 'platform' | 'genre'>): Kind => cfg.platform !== 'footage' ? 'gaming' : cfg.genre === 'music' ? 'music' : 'talk';
/** Up to max testing proposals of one kind (or of every kind when unset), oldest first. */
export const activeProposals = (max = 6, kind?: Kind) => proposals().filter((p) => p.status === 'testing' && !p.untested && (!kind || kindOf(p) === kind)).sort((a, b) => a.created - b.created).slice(0, max);

/** Approved changes in approval order; later ones win. The live render uses only these. */
export const tweaks = (ps = proposals(), kind: Kind = 'gaming'): Change =>
  Object.assign({}, ...ps.filter((p) => p.status === 'approved' && kindOf(p) === kind).sort((a, b) => (a.decided ?? 0) - (b.decided ?? 0)).map((p) => p.change));

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
  if (cur.weeklyPer && cur.weeklyPer !== cur.per) add({ id: `words-${cur.weeklyPer}`, title: `${cur.weeklyPer} word${cur.weeklyPer === 1 ? "" : "s"} per caption line`, why: `Most top gaming Shorts this week show about ${cur.weeklyPer} words per line (weekly study). Now ${cur.per}.`, change: { wordsPerChunk: cur.weeklyPer } });
  const fewer = Math.max(1, cur.per - 1);
  if (fewer !== cur.weeklyPer && fewer !== cur.per) add({ id: `words-${fewer}`, title: `${fewer} word${fewer === 1 ? "" : "s"} per caption line`, why: `Fewer words at once are faster to read on a phone. Now ${cur.per}.`, change: { wordsPerChunk: fewer } });
  add({ id: 'captions-lower', title: 'Captions 150 px lower', why: 'Lower captions cover less of the face and the action; still above the app buttons.', change: { captionShift: 150 } });
  // Length (trim.ts: lead 12s, target 12-26s). Judged on transcripts: does the cut keep the build-up and end on the payoff?
  add({ id: 'lead-6', title: 'Shorter build-up (6 s before the peak)', why: 'Gets to the point faster; most viewers decide in the first seconds. Now 12 s.', change: { leadSec: 6 } });
  add({ id: 'lead-18', title: 'Longer build-up (18 s before the peak)', why: 'More context, so the joke lands for someone who never saw the stream. Now 12 s.', change: { leadSec: 18 } });
  add({ id: 'max-20', title: 'Clips at most 20 s', why: 'Nov 24 study: clips under 20 s beat the streamer median 54% vs ~33% for longer. Now up to 26 s.', change: { maxLen: 20 } });
  // Calibration (docs/practice-calibration.md): lacy's chat overlay (top-right, y < 0.18) cuts into the center crop. Same 1080:1152 shape, below it.
  add({ id: 'crop-lacy', title: 'Lacy: game part without his chat box', why: 'The judge saw his stream chat overlay inside the game part. It sits top-right; this crop starts below it (zoom 1.2x).', change: { gameCrop: { lacy: { x: 0.284, y: 0.18, w: 0.432, h: 0.82 } } } });
  for (const s of (['pop', 'clean'] as CaptionStyle[]).filter((x) => x !== cur.style)) add({ id: `style-${s}`, title: `Caption style "${s}"`, why: `Test the ${s} caption look against the current "${cur.style}".`, change: { captionStyle: s } });
  // Podcasts and shows: the same tests on their own clips, since what works for a stream may not for a talk clip.
  const t = (id: string, title: string, why: string, change: Change, kind: Kind) => add({ id: `${id}-${kind}`, title, why, change, kind });
  if (fewer !== cur.per) t(`words-${fewer}`, `${fewer} word${fewer === 1 ? "" : "s"} per caption line`, `Fewer words at once are faster to read on a phone. Now ${cur.per}.`, { wordsPerChunk: fewer }, 'talk');
  t('captions-lower', 'Captions 150 px lower', 'Lower captions cover less of the faces; still above the app buttons.', { captionShift: 150 }, 'talk');
  for (const s of (['pop', 'clean'] as CaptionStyle[]).filter((x) => x !== cur.style)) t(`style-${s}`, `Caption style "${s}"`, `Test the ${s} caption look against the current "${cur.style}".`, { captionStyle: s }, 'talk');
  // Length for podcasts and music (music has no captions to test).
  for (const kind of ['talk', 'music'] as Kind[]) {
    t('lead-6', 'Shorter build-up (6 s before the peak)', 'Gets to the point faster; most viewers decide in the first seconds. Now 12 s.', { leadSec: 6 }, kind);
    t('lead-18', 'Longer build-up (18 s before the peak)', 'More context, so the moment makes sense to someone who never saw the episode. Now 12 s.', { leadSec: 18 }, kind);
    t('max-20', 'Clips at most 20 s', 'Shorter clips are watched to the end more often. Now up to 26 s.', { maxLen: 20 }, kind);
  }
  saveProposals(ps);
}

/** Metadata from the weekly study becomes an untested proposal, once per study run; live titles never follow the study on their own. */
export function seedStudy(study: { at: string | null; titles: string[]; hashtags?: string[]; titleLen?: number | null }) {
  if (!study.at) return;
  const day = study.at.slice(0, 10), note = 'From the weekly study, not tested: real views after posting measure it.';
  if (study.titles.length) addProposal({ id: `titles-${day}`, title: "Title style of this week's top Shorts", why: `The title writer copies the style (not the content) of the ${study.titles.length} most-viewed gaming Shorts of the weekly study.`, change: { titleExamples: study.titles } });
  if (study.hashtags?.length) addProposal({ id: `hashtags-${day}`, title: `Add ${study.hashtags.join(' ')}`, why: "General hashtags used by several channels in this week's top gaming Shorts. Added after the streamer tag and #ad, never instead of them.", change: { hashtags: study.hashtags }, evidence: note });
  // 70 = cleanTitle default; only worth asking when the top Shorts clearly differ.
  if (study.titleLen && Math.abs(study.titleLen - 70) >= 15) addProposal({ id: `title-len-${day}`, title: `Titles up to ${study.titleLen} characters`, why: `Median title length of this week's top gaming Shorts is ${study.titleLen}. Now up to 70.`, change: { titleMax: study.titleLen }, evidence: note });
}

/** Untested proposal from a study or the learner; waits for the owner ("ready"). Same id twice is ignored. */
export function addProposal(p: Pick<Proposal, 'id' | 'title' | 'why' | 'change' | 'evidence'>) {
  const ps = proposals();
  if (ps.some((x) => x.id === p.id)) return false;
  ps.push({ ...p, untested: true, status: 'ready', created: Date.now(), pairs: [], aa: [], frames: [] });
  saveProposals(ps);
  return true;
}

export const hasProposals = () => existsSync(file());
