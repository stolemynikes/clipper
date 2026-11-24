import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earn, setEnv } from './setup.ts';

test('setEnv replaces or appends, keeps $ literal', () => {
  assert.equal(setEnv('A=1\nB=2\n', 'B', 'x$&y'), 'A=1\nB=x$&y\n');
  assert.equal(setEnv('A=1', 'C', '3'), 'A=1\nC=3\n');
  assert.equal(setEnv('', 'C', '3'), 'C=3\n');
  assert.equal(setEnv('AB=1\n', 'B', '2'), 'AB=1\nB=2\n'); // no partial key match
});

test('earn: rate per 1K, capped per clip, pool = 0', () => {
  assert.equal(earn(25_000, 2, 0), 50);
  assert.equal(earn(25_000, 2, 30), 30);
  assert.equal(earn(25_000, 0, 0), 0);
});
