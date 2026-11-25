import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysLeft } from './api.ts';

test('daysLeft: end date counts as a full day, never negative', () => {
  const now = new Date('2026-11-25T12:00:00Z').getTime();
  assert.equal(daysLeft('2026-11-25', now), 1);
  assert.equal(daysLeft('2026-11-30', now), 6);
  assert.equal(daysLeft('2026-11-01', now), 0);
});

test('earnings: paid and pending payouts are summed apart', async () => {
  const { openDb } = await import('../db/client.ts');
  const { payouts } = await import('../db/schema.ts');
  const { earnings } = await import('./api.ts');
  const db = openDb(':memory:');
  db.insert(payouts).values([{ campaign: 'x', amount: 12.5, status: 'paid', paidAt: new Date() }, { campaign: 'x', amount: 3 }, { campaign: 'y', amount: 1.25, status: 'paid' }]).run();
  const e = earnings(db);
  assert.equal(e.paid, 13.75);
  assert.equal(e.pending, 3);
  assert.equal(e.payouts.length, 3);
});
