import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaignNotes, profitScore } from './campaign-notes.ts';

const now = new Date('2026-11-24T12:00:00Z');

test('pool with a high bar warns', () => {
  const r = campaignNotes({ platform: 'content_rewards', ratePer1k: 0, maxPerClip: 0, pool: 5000, endsAt: '2026-11-30',
    rules: { minViews: 500000, platforms: ['tiktok', 'youtube'] } }, now);
  assert.deepEqual(r.facts, ['$5,000 pool, split by views when it ends', 'Pays only after 500,000 views in total', 'Counts on: TikTok, YouTube', 'Ends Nov 30']);
  assert.deepEqual(r.warnings, ['High bar: likely little or no pay']);
});

test('rate campaign: low rate and ending soon warn', () => {
  const r = campaignNotes({ platform: 'content_rewards', ratePer1k: 0.5, maxPerClip: 200, endsAt: '2026-11-25' }, now);
  assert.equal(r.facts[0], '$0.50 per 1,000 views, at most $200 per clip');
  assert.deepEqual(r.warnings, ['Ends in 2 days: new clips have little time to get views', 'Low rate: likely little pay']);
});

test('good campaign has no warnings; ended one says so', () => {
  const c = { platform: 'content_rewards', ratePer1k: 1, maxPerClip: 500, endsAt: '2026-12-31' };
  assert.deepEqual(campaignNotes(c, now).warnings, []);
  assert.deepEqual(campaignNotes({ ...c, endsAt: '2026-11-23' }, now).warnings, ['Ended: no new clips']);
});

test('profit score: bigger pool and lower bar rank first', () => {
  const base = { platform: 'content_rewards', ratePer1k: 0, maxPerClip: 0, endsAt: '2026-11-30' };
  const clix = profitScore({ ...base, pool: 5000, rules: { minViews: 500000 } });
  const silky = profitScore({ ...base, pool: 7500, rules: { minViews: 250000 } });
  assert.equal(clix, 10);
  assert.equal(silky, 30);
  assert.equal(profitScore({ ...base, ratePer1k: 1.5 }), 1.5);
  assert.equal(profitScore({ ...base, pool: 1000 }), 10); // no bar: assumed 100K
});
