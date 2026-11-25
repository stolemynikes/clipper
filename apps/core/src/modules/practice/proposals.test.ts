import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aaBias, type Pair, type Proposal, score, tweaks } from './proposals.ts';

const pairs = (n: number, pick: Pair['pick']): Pair[] => Array.from({ length: n }, (_, i) => ({ clipId: i, newFirst: i % 2 === 0, pick, why: '', at: 0 }));
const prop = (id: string, change: Proposal['change'], status: Proposal['status'], decided?: number): Proposal =>
  ({ id, title: id, why: '', change, status, decided, created: 0, pairs: [], aa: [], frames: [] });

test('score hides below 20 pairs, counts same as half, gives a Wilson interval', () => {
  assert.equal(score({ pairs: pairs(19, 'new') }), null);
  const s = score({ pairs: [...pairs(14, 'new'), ...pairs(4, 'old'), ...pairs(2, 'same')] })!;
  assert.equal(s.n, 20); assert.equal(s.wins, 15); assert.equal(s.share, 0.75);
  assert.ok(s.low > 0.5 && s.low < 0.75 && s.high > 0.75 && s.high < 1);
  const even = score({ pairs: [...pairs(10, 'new'), ...pairs(10, 'old')] })!;
  assert.ok(even.low < 0.5 && even.high > 0.5); // a coin flip must not look like a win
});

test('aaBias flags a judge that always picks the first clip', () => {
  assert.equal(aaBias({ aa: [{ pick: 1 }, { pick: 1 }, { pick: 1 }, { pick: 1 }, { pick: 1 }] }).biased, true);
  assert.equal(aaBias({ aa: [{ pick: 1 }, { pick: 2 }, { pick: 1 }, { pick: 2 }] }).biased, false);
  const b = aaBias({ aa: [{ pick: 0 }, { pick: 0 }, { pick: 1 }] });
  assert.equal(b.biased, false); assert.equal(b.sameShare, 2 / 3); // too few real picks to call it
});

test('tweaks uses only approved proposals, later approval wins', () => {
  assert.deepEqual(tweaks([prop('a', { wordsPerChunk: 2 }, 'testing'), prop('b', { captionShift: 150 }, 'rejected', 1)]), {});
  assert.deepEqual(tweaks([prop('a', { wordsPerChunk: 4 }, 'approved', 2), prop('b', { wordsPerChunk: 2, captionShift: 150 }, 'approved', 1)]), { wordsPerChunk: 4, captionShift: 150 });
});

test('study titles become one untested proposal per study run, live only after approval', () => {
  const p = { ...prop('t', { titleExamples: ['A', 'B'] }, 'ready'), untested: true };
  assert.deepEqual(tweaks([p]), {});
  assert.deepEqual(tweaks([{ ...p, status: 'approved', decided: 1 }]), { titleExamples: ['A', 'B'] });
});
