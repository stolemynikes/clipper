import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceZone, nextPostAt, postSlot } from './post-time.ts';

test('audience zone: first named region, US default', () => {
  assert.equal(audienceZone('40% of views from US/UK/CA/AU'), 'America/New_York');
  assert.equal(audienceZone('Tier 1: UK, US'), 'Europe/London');
  assert.equal(audienceZone('Australia only'), 'Australia/Sydney');
  assert.equal(audienceZone(undefined), 'America/New_York');
  assert.equal(audienceZone('anywhere'), 'America/New_York');
});

test('post slot lands in the audience evening', () => {
  // 12:00 UTC = 07:00 New York (winter, UTC-5): wait until 17:00 NY = 22:00 UTC
  assert.equal(postSlot(new Date('2026-12-01T12:00:00Z'), 'America/New_York').toISOString(), '2026-12-01T22:00:00.000Z');
  // already in the window: post now
  const inWin = new Date('2026-12-01T23:10:00Z');
  assert.equal(postSlot(inWin, 'America/New_York'), inWin);
  // past the window (03:00 NY): next evening
  assert.equal(postSlot(new Date('2026-12-02T08:00:00Z'), 'America/New_York').toISOString(), '2026-12-02T22:00:00.000Z');
  // summer time: 17:00 NY = 21:00 UTC
  assert.equal(postSlot(new Date('2026-07-01T12:00:00Z'), 'America/New_York').toISOString(), '2026-07-01T21:00:00.000Z');
});

test('posts on one account keep the gap', () => {
  const now = new Date('2026-12-01T22:30:00Z'); // 17:30 NY
  assert.equal(nextPostAt(now, null, 'America/New_York', 90), now);
  assert.equal(nextPostAt(now, new Date('2026-12-01T22:00:00Z'), 'America/New_York', 90).toISOString(), '2026-12-01T23:30:00.000Z');
  // gap pushes past 22:00 NY: next evening
  assert.equal(nextPostAt(now, new Date('2026-12-02T02:00:00Z'), 'America/New_York', 90).toISOString(), '2026-12-02T22:00:00.000Z');
});
