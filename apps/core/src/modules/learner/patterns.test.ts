import assert from 'node:assert/strict';
import { test } from 'node:test';
import { learnedLines, patterns, type Row } from './patterns.ts';

const row = (i: number, group: Row['group'], labels: string[], laugh = false): Row =>
  ({ id: `${group}${i}`, kind: 'talk', group, at: '2026-11-27T00:00:00Z', views: 1, labels, question: false, hook: true, laugh, cheer: false, fast: false });

test('not ready below 30 rows per group: no lines', () => {
  const rows = [...Array(29)].map((_, i) => row(i, 'top', ['hot take']));
  assert.equal(patterns(rows).ready, false);
  assert.deepEqual(learnedLines(rows), { works: [], weak: [] });
});

test('trait common in top, rare in flop, becomes a line; shared trait does not', () => {
  const rows = [
    ...[...Array(30)].map((_, i) => row(i, 'top', i < 18 ? ['hot take'] : ['advice'], i < 15)),
    ...[...Array(30)].map((_, i) => row(i, 'flop', i < 3 ? ['hot take'] : ['advice'])),
  ];
  const p = patterns(rows);
  assert.equal(p.ready, true);
  const hot = p.list.find((x) => x.trait === 'hot take')!;
  assert.deepEqual([hot.top, hot.flop, hot.lift], [0.6, 0.1, 0.5]);
  assert.equal(p.list.find((x) => x.trait === 'hook')!.lift, 0); // every row has it: no signal
  assert.ok(p.list.some((x) => x.trait === 'hot take + laugh')); // combos counted
  const { works, weak } = learnedLines(rows);
  assert.equal(works[0], 'hot take (in 60% of top Shorts, 10% of weak ones)');
  assert.ok(works.every((l) => !l.startsWith('someone talks')));
  assert.equal(weak[0], 'advice (in 40% of top Shorts, 90% of weak ones)');
});

test('difference that may be chance is not a line', () => {
  const rows = [ // 9/30 vs 4/30: lift 0.17 but z 1.6
    ...[...Array(30)].map((_, i) => row(i, 'top', i < 9 ? ['hot take'] : ['advice'])),
    ...[...Array(30)].map((_, i) => row(i, 'flop', i < 4 ? ['hot take'] : ['advice'])),
  ];
  assert.equal(patterns(rows).list.find((x) => x.trait === 'hot take')!.lift, 0.17);
  assert.ok(learnedLines(rows).works.every((l) => !l.startsWith('hot take')));
});
