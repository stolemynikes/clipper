import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimWindow } from './trim.ts';

// One 4-word sentence every 5s ("a b c d."), word 0.3s long, 0.5s between words.
const talk = (from: number, to: number) => {
  const out = [];
  for (let t = from; t < to; t += 5) for (let k = 0; k < 4; k++) out.push({ w: k === 3 ? 'd.' : 'a', s: t + k * 0.8, e: t + k * 0.8 + 0.3 });
  return out;
};
const base = { durationSec: 60, peakRel: 47, windowSec: 5, tailSec: 8, targetSec: [20, 45] as [number, number], minSec: 15, maxSec: 60 };

test('ends after the reaction, starts on a sentence about 12s before the peak', () => {
  const r = trimWindow({ ...base, words: talk(0, 60) });
  assert.ok(r.end > 47 + 5 && r.end <= 60);
  assert.equal(r.start, 34.7); // sentence at 35s, closest to 47-12=35 within [end-45, end-20]
  const len = r.end - r.start;
  assert.ok(len >= 20 && len <= 45, `len ${len}`);
});

test('runs on to the end of the sentence said at the tail', () => {
  const words = [{ w: 'wait', s: 58.5, e: 58.9 }, { w: 'what', s: 59.0, e: 59.4 }, { w: 'happened?', s: 59.5, e: 60.5 }];
  const r = trimWindow({ ...base, durationSec: 70, peakRel: 46, words: [...talk(20, 58), ...words] });
  assert.equal(r.end, 60.8);
});

test('campaign max caps the length', () => {
  const r = trimWindow({ ...base, maxSec: 25, words: talk(0, 60) });
  assert.ok(r.end - r.start <= 25);
});

test('silence before the talking: starts just before the first sentence', () => {
  const r = trimWindow({ ...base, words: talk(35, 60) });
  assert.equal(r.start, 34.7);
});

test('long silence at the start is cut, keeping minSec', () => {
  assert.equal(trimWindow({ ...base, words: talk(50, 60) }).start, 45); // first word 50 -> 49, but min 15s before end 60
});

test('no words: plain window around the peak', () => {
  assert.deepEqual(trimWindow({ ...base, words: [] }), { start: 35, end: 60 });
});

test('leadSec moves the start: shorter or longer build-up before the peak', () => {
  assert.deepEqual(trimWindow({ ...base, words: [], leadSec: 6 }), { start: 40, end: 60 }); // 41 wanted, min length 20 s wins
  assert.deepEqual(trimWindow({ ...base, words: [], leadSec: 18 }), { start: 29, end: 60 });
});
