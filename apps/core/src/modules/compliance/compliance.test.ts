import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClip, type ComplianceInput } from './compliance.ts';

const base: ComplianceInput = {
  campaign: { endsAt: '2026-11-30', rules: { sourceFrom: '2026-01-01' } },
  tag: '@Clix', durationSec: 45, limits: { minSec: 15, maxSec: 60 },
  disclosureRequired: true, disclosure: '#ad', music: { musicRatio: 0, vocalRatio: 0 },
  transcript: 'oh my god he hit the shot', sourceDate: new Date('2026-11-20'), now: new Date('2026-11-24'),
};
const check = (o: Partial<ComplianceInput>) => checkClip({ ...base, ...o });

test('clean clip passes', () => {
  assert.deepEqual(check({}), { ok: true, blocks: [], warnings: [] });
});

test('no campaign or ended campaign blocks', () => {
  assert.match(check({ campaign: null }).blocks[0], /No active campaign/);
  assert.match(check({ now: new Date('2026-12-01T01:00:00') }).blocks[0], /ended/);
  assert.equal(check({ now: new Date('2026-11-30T20:00:00') }).ok, true); // last day still counts
});

test('source older than the brief allows blocks', () => {
  assert.match(check({ sourceDate: new Date('2025-12-31') }).blocks[0], /older/);
});

test('length limits', () => {
  assert.match(check({ durationSec: 10 }).blocks[0], /Too short/);
  assert.match(check({ durationSec: 75 }).blocks[0], /Too long/);
  assert.equal(check({ durationSec: 60.3 }).ok, true);
});

test('disclosure and tag are required', () => {
  assert.match(check({ disclosure: null }).blocks[0], /disclosure/);
  assert.equal(check({ disclosure: null, disclosureRequired: false }).ok, true);
  assert.match(check({ tag: '' }).blocks[0], /tag/);
});

test('gambling blocks, gaming slang does not', () => {
  assert.match(check({ transcript: 'use my Stake code for free spins' }).blocks[0], /Gambling/);
  assert.match(check({ transcript: 'we hit the casino tonight' }).blocks[0], /casino/);
  assert.equal(check({ transcript: 'swap your inventory slots, I will gamble on this fight' }).ok, true);
});

test('music: song blocks, some music warns', () => {
  assert.match(check({ music: { musicRatio: 0.3, vocalRatio: 0.2 } }).blocks[0], /song/);
  assert.match(check({ music: { musicRatio: 0.6, vocalRatio: 0 } }).blocks[0], /music/);
  const some = check({ music: { musicRatio: 0.24, vocalRatio: 0 } }); // clip 23: Team Falcons video in the background
  assert.equal(some.ok, true);
  assert.match(some.warnings[0], /background music/);
  assert.match(check({ music: null }).warnings[0], /did not run/);
});
