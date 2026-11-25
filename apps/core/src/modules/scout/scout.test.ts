import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamerConfig } from '../../config.ts';
import { toEntry } from '../../review/campaigns.ts';
import { type CrCampaign, formOf, pickCampaigns } from './scout.ts';

const camp = (o: Partial<CrCampaign> = {}): CrCampaign => ({
  id: 'abc', name: 'Lacy GTA 6 Pool', status: 'active', private: false, requiresApplication: false, budgetCents: 1_250_000,
  payoutType: 'pool', platforms: ['tiktok', 'youtube'], payouts: [{ platform: 'tiktok', payoutType: 'pool' }, { platform: 'youtube', payoutType: 'pool' }],
  referenceMaterials: [{ url: 'https://www.twitch.tv/Lacy' }], ...o,
});

test('picks open Twitch campaigns, biggest budget first', () => {
  const list = [camp({ id: 'a', budgetCents: 100 }), camp({ id: 'b', budgetCents: 900, referenceMaterials: [{ url: 'https://twitch.tv/kai' }] })];
  assert.deepEqual(pickCampaigns(list, []).map((c) => c.id), ['b', 'a']);
});

test('skips gambling, private, application, no Twitch, already saved, non-paying', () => {
  const saved = [{ name: 'kai', channel: 'kai', campaign: { url: 'https://contentrewards.com/c/campaigns/x' } }] as StreamerConfig[];
  const list = [
    camp({ name: 'GTA x 1WIN' }), camp({ private: true }), camp({ requiresApplication: true }), camp({ status: 'ended' }),
    camp({ referenceMaterials: [] }), camp({ referenceMaterials: [{ url: 'https://twitch.tv/kai' }] }), camp({ id: 'x', referenceMaterials: [{ url: 'https://twitch.tv/other' }] }),
    camp({ payoutType: 'cpm', payouts: [{ platform: 'tiktok', payoutType: 'cpm', rateCents: 0 }, { platform: 'x', payoutType: 'cpm', rateCents: 50 }] }),
  ];
  assert.deepEqual(pickCampaigns(list, saved), []);
});

test('caps picks per run', () => {
  const list = ['a', 'b', 'c', 'd'].map((id) => camp({ id, referenceMaterials: [{ url: `https://twitch.tv/s${id}` }] }));
  assert.equal(pickCampaigns(list, [], 3).length, 3);
});

test('rate campaign: only platforms with a rate, money from cents, valid entry', () => {
  const c = camp({ payoutType: 'cpm', budgetCents: 1_500_000, metrics: { budgetSpentCents: 500_000 }, payouts: [
    { platform: 'instagram', payoutType: 'cpm', rateCents: 30, maxPayoutCents: 15000 }, { platform: 'tiktok', payoutType: 'cpm', rateCents: 0, maxPayoutCents: 15000 }] });
  const f = formOf(c, { tag: '@lacy' }, new Date('2026-11-24'));
  assert.deepEqual(f.platforms, ['instagram']);
  assert.equal(f.ratePer1k, 0.3);
  assert.equal(f.maxPerClip, 150);
  assert.equal(f.budgetLeft, 10_000);
  assert.equal(f.endsAt, '2026-12-24');
  const e = toEntry(f);
  assert.equal(e.channel, 'lacy');
  assert.equal(e.campaign!.url, 'https://contentrewards.com/c/campaigns/abc');
});

test('pool campaign: pool from budget, no rate', () => {
  const f = formOf(camp(), {});
  assert.equal(f.pool, 12_500);
  assert.equal(f.ratePer1k, 0);
  assert.equal(toEntry(f).tag, '@lacy');
});

test('whyNot gives a plain reason per blocked campaign', async () => {
  const { whyNot } = await import('./scout.ts');
  const base = { id: 'x', name: 'Clip', status: 'active', private: false, requiresApplication: false, budgetCents: 100_00, payoutType: 'rate', platforms: ['tiktok'],
    payouts: [{ platform: 'tiktok', payoutType: 'rate', rateCents: 100 }], referenceMaterials: [{ url: 'https://twitch.tv/somebody' }] } as CrCampaign;
  assert.equal(whyNot(base, []), null);
  assert.equal(whyNot({ ...base, name: 'Stake casino clips' }, []), 'Gambling');
  assert.equal(whyNot({ ...base, referenceMaterials: [] }, []), 'No Twitch streamer');
  assert.equal(whyNot(base, [{ name: 'somebody', channel: 'somebody' } as never]), 'Already joined');
});
