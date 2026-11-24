import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaignOpen } from './config.ts';

test('campaignOpen: through the end date, off when the budget is nearly gone', () => {
  const c = { platform: 'content_rewards', ratePer1k: 2, maxPerClip: 0, endsAt: '2026-11-30' };
  assert.equal(campaignOpen(c, new Date('2026-11-30T20:00:00Z')), true);
  assert.equal(campaignOpen(c, new Date('2026-12-01T01:00:00Z')), false);
  assert.equal(campaignOpen({ ...c, budgetLeft: 20 }, new Date('2026-11-24')), false);
  assert.equal(campaignOpen({ ...c, budgetLeft: 4200 }, new Date('2026-11-24')), true);
});
