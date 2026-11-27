import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamerConfig } from '../../config.ts';
import { toEntry } from '../../review/campaigns.ts';
import { type CrCampaign, crState, formOf, hrefsOf, slugOf, syncCrState, pickCampaigns, whyNot } from './scout.ts';
import { campaignOpen } from '../../config.ts';

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
  assert.equal(whyNot({ ...base, referenceMaterials: [] }, [], { [base.id]: 'footage' }), 'Gives its own videos, but not as a Google Drive or Dropbox folder');
  assert.equal(whyNot({ ...base, referenceMaterials: [] }, [], { [base.id]: 'gambling' }), 'Gambling');
  assert.equal(whyNot(base, [{ name: 'somebody', channel: 'somebody' } as never]), 'Already joined');
});

test('crState: closed card by streamer name, budget left from card text', () => {
  const scan = { at: null, campaigns: [], joined: [{ name: 'Kai Cenat - $10,000 GTA 6 Pool Campaign', closed: true, spent: null, budget: null }, { name: 'Boeshi GTA 6 Clipping', closed: false, spent: '278', budget: '1,750' }] };
  assert.deepEqual(crState('https://x/c/campaigns/zz', ['kaicenat'], scan), { closed: true, budget: 0, left: 0 });
  assert.deepEqual(crState(undefined, ['boeshi'], scan), { closed: false, budget: 1750, left: 1472 });
  assert.equal(crState(undefined, ['nobody'], scan), null);
});

test('syncCrState: closed CR campaign is marked closed and stops being open', () => {
  const scan = { at: null, campaigns: [], joined: [{ name: 'Kai Cenat - $10,000 GTA 6 Pool Campaign', closed: true, spent: null, budget: null }, { name: 'Boeshi GTA 6 Clipping', closed: false, spent: '278', budget: '1,750' }] };
  const camp = { platform: 'content_rewards', ratePer1k: 1, maxPerClip: 0, endsAt: '2099-01-01' };
  const list = [{ name: 'Kai Cenat', channel: 'kaicenat', campaign: camp }, { name: 'Boeshi', channel: 'boeshi', campaign: { ...camp, budgetLeft: 1472 } }] as never[];
  const saved: Record<string, any> = {};
  syncCrState(scan, list, (n, p) => { saved[n] = p; });
  assert.deepEqual(Object.keys(saved), ['Kai Cenat']);
  assert.equal(saved['Kai Cenat'].closed, true);
  assert.equal(campaignOpen({ ...camp, ...saved['Kai Cenat'] }), false);
  assert.equal(campaignOpen(camp), true);
});

test('footage campaigns: joinable with a Drive link, a plain reason without', () => {
  const f = camp({ id: 'ft', name: 'Brand podcast clips', organizationName: 'Big Pod Co.', referenceMaterials: [{ url: 'https://drive.google.com/drive/folders/abc123defg45' }] });
  assert.equal(whyNot(f, [], { ft: 'footage' }), null);
  assert.match(whyNot({ ...f, referenceMaterials: [] }, [], { ft: 'footage' }) ?? '', /Drive or Dropbox/);
  assert.equal(slugOf(f), 'big_pod_co');
  const entry = toEntry(formOf(f, {}, new Date('2026-11-24'), ['https://drive.google.com/drive/folders/abc123defg45']));
  assert.equal(entry.platform, 'footage'); assert.equal(entry.stage, 'clips'); assert.equal(entry.enabled, false); assert.equal(entry.tag, '');
  assert.deepEqual(entry.footage, ['https://drive.google.com/drive/folders/abc123defg45']);
  assert.deepEqual(hrefsOf('<a href="https://www.google.com/url?q=https://www.dropbox.com/scl/fo/x/y?rlkey%3Dk%26dl%3D0&amp;sa=D">HERE</a> <a href="https://a.b/c?d=1&amp;e=2">x</a>'),
    ['https://www.dropbox.com/scl/fo/x/y?rlkey=k&dl=0', 'https://a.b/c?d=1&e=2']);
  assert.equal(whyNot(f, [entry], { ft: 'footage' }), 'Already joined');
});
