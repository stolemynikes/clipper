import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickStyle, styleWinner, type StyleStat } from './title-style.ts';

const s = (mild: [number, number], bold: [number, number]): StyleStat[] =>
  [{ style: 'mild', posts: mild[0], median: mild[1] }, { style: 'bold', posts: bold[0], median: bold[1] }];

test('no winner with too few posts or a small difference', () => {
  assert.equal(styleWinner(s([9, 100], [20, 1000])), null);
  assert.equal(styleWinner(s([10, 1000], [10, 1100])), null);
  assert.equal(styleWinner(s([10, 0], [10, 0])), null);
});

test('clear winner gets 80% of new clips, loser keeps 20%', () => {
  const st = s([10, 500], [12, 1000]);
  assert.equal(styleWinner(st), 'bold');
  assert.equal(pickStyle(st, 0.79), 'bold');
  assert.equal(pickStyle(st, 0.81), 'mild');
  assert.equal(pickStyle(s([0, 0], [0, 0]), 0.49), 'mild');
  assert.equal(pickStyle(s([0, 0], [0, 0]), 0.5), 'bold');
});
