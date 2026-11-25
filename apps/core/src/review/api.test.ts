import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysLeft } from './api.ts';

test('daysLeft: end date counts as a full day, never negative', () => {
  const now = new Date('2026-11-25T12:00:00Z').getTime();
  assert.equal(daysLeft('2026-11-25', now), 1);
  assert.equal(daysLeft('2026-11-30', now), 6);
  assert.equal(daysLeft('2026-11-01', now), 0);
});
