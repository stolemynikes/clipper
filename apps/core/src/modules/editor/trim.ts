// Picks the part of the downloaded window to keep: start at a sentence before the build-up,
// end after the reaction (peak + tail, run on to the end of that sentence). Pure, no I/O.
import type { Word } from './subtitles.ts';

export interface TrimInput {
  words: Word[]; // clip-relative times
  durationSec: number; // length of the downloaded window
  peakRel: number; // start of the peak window, clip seconds
  windowSec: number;
  tailSec: number;
  targetSec: [number, number];
  minSec: number;
  maxSec: number;
  leadSec?: number; // build-up before the peak; default LEAD_SEC (a length proposal may change it)
}

const LEAD_SEC = 12; // ideal build-up before the peak: 12 + window + tail ~ 25s, the popular Shorts length (median 23s)
const RUN_ON_SEC = 4; // finish the sentence after the tail, but not longer than this
const GAP = 0.6;
const ends = (w: Word) => /[.!?]["')]*$/.test(w.w);

export function trimWindow(o: TrimInput): { start: number; end: number } {
  const { words: ws, durationSec: dur } = o;
  const maxLen = Math.min(o.maxSec, o.targetSec[1]);
  let end = Math.min(dur, o.peakRel + o.windowSec + o.tailSec);
  // Run on to the end of the sentence being said at `end`.
  const i = ws.findIndex((w) => w.e >= end);
  if (i >= 0 && ws[i].s < end + 0.3) {
    for (let j = i; j < ws.length && ws[j].e <= end + RUN_ON_SEC; j++) {
      if (ends(ws[j]) || j === ws.length - 1 || ws[j + 1].s - ws[j].e > GAP) { end = Math.max(end, ws[j].e + 0.3); break; }
    }
  }
  end = Math.min(dur, end);

  const lo = Math.max(0, end - maxLen), hi = Math.max(lo, end - o.targetSec[0]);
  const ideal = Math.min(hi, Math.max(lo, o.peakRel - (o.leadSec ?? LEAD_SEC)));
  // Sentence starts: first word, or a word after a full stop or a pause.
  const starts = ws.filter((w, k) => k === 0 || ends(ws[k - 1]) || w.s - ws[k - 1].e > GAP).map((w) => Math.max(0, w.s - 0.3))
    .filter((s) => s >= lo && s <= hi);
  let start = starts.length ? starts.reduce((a, b) => (Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a)) : ideal;
  // Dead air at the start loses viewers: begin 1s before the first word if nobody talks for 3s (keeping minSec).
  const first = ws.find((w) => w.s >= start);
  if (first && first.s - start > 3) start = Math.max(start, Math.min(first.s - 1, end - o.minSec));
  return { start, end };
}
