import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamerConfig } from '../config.ts';
import { categoryName, clipEmbed, infoEmbed, statsText, totalsText } from './bot.ts';

const acct = (o: Partial<{ streamer: string; platform: 'tiktok' | 'youtube'; name: string; pool: boolean; posts: number; views: number; earned: number }>) =>
  ({ id: 1, platform: 'tiktok' as const, name: 'acc', streamer: 'lacy', pool: false, posts: 1, views: 1000, earned: 1, ...o });

test('stats: sums only this campaign, money for rate campaigns', () => {
  const t = statsText('lacy', [acct({ views: 12_000, earned: 3.5 }), acct({ platform: 'youtube', views: 3000, earned: 1.25 }), acct({ streamer: 'kai', earned: 99 })]);
  assert.match(t, /2 posts · 15,000 views · \$4\.75 earned/);
  assert.doesNotMatch(t, /99/);
});

test('stats: pool shows views, no made-up money', () => {
  const t = statsText('lacy', [acct({ pool: true, earned: 0, views: 500 })]);
  assert.match(t, /pool share \(not known yet\)/);
  assert.doesNotMatch(t, /\$/);
});

test('stats: no posts', () => assert.equal(statsText('lacy', [acct({ posts: 0 })]), '**lacy** · no posts yet'));

const lacy = (o: Record<string, unknown> = {}) => ({ name: 'lacy', channel: 'lacy', tag: '@lacy', campaign: { platform: 'contentrewards', ratePer1k: 1, maxPerClip: 100, endsAt: '2026-12-31', url: 'https://contentrewards.com/c/campaigns/x', rules: { hashtags: ['#Lacy'] } }, ...o }) as unknown as StreamerConfig;

test('info: card with pay, end date, tag and link; green while open', () => {
  const e = infoEmbed(lacy(), new Date('2026-11-24'));
  const f = Object.fromEntries((e.fields ?? []).map((x) => [x.name, x.value]));
  assert.match(f.Pay, /\$1 per 1,000 views, at most \$100 per clip/);
  assert.equal(f.Ends, 'Dec 31');
  assert.equal(f.Tag, '@lacy');
  assert.equal(f.Hashtags, '#Lacy');
  assert.equal(e.url, 'https://contentrewards.com/c/campaigns/x');
  assert.equal(e.color, 0x22c55e);
  assert.equal(infoEmbed(lacy(), new Date('2027-01-05')).color, 0xef4444);
});

test('category: dot shows open, off or closed', () => {
  assert.equal(categoryName(lacy(), new Date('2026-11-24')), '🟢 lacy · $1/1K');
  assert.equal(categoryName(lacy({ enabled: false }), new Date('2026-11-24')), '⏸️ lacy · $1/1K');
  assert.match(categoryName(lacy(), new Date('2027-01-05')), /^🔴/);
});

test('totals: money only from rate campaigns, clips per status', () => {
  const t = totalsText([acct({ views: 12_000, earned: 3.5 }), acct({ streamer: 'kai', pool: true, views: 8000, earned: 0 }), acct({ posts: 0, views: 0, earned: 0 })],
    [{ status: 'pending_review', n: 2 }, { status: 'posted', n: 3 }], false);
  assert.match(t, /\$3\.50 earned \(plus pool shares/);
  assert.match(t, /20,000 views · 📤 2 posts/);
  assert.match(t, /5 clips: 2 to review, 0 kept, 3 posted, 0 skipped/);
  assert.match(t, /• lacy: 1 posts, 12,000 views, \$3\.50\n• kai: 1 posts, 8,000 views\n/);
});

test('clip card: hook in italics, caption shown, warnings only when present', () => {
  const e = clipEmbed({ title: 'Lacy loses it', hook: 'Wait for it', caption: 'Lacy loses it #ad @lacy', seconds: 23.4, why: ['Chat got busy'], warnings: [] });
  assert.equal(e.description, '*Wait for it*');
  assert.deepEqual(e.fields?.map((f) => f.name), ['Length', 'Status', 'Caption', 'Why this moment']);
  assert.equal(e.fields?.[0].value, '23s');
  assert.equal(clipEmbed({ rating: 9, title: 't', hook: null, caption: 'c', seconds: 5, why: [], warnings: [] }).fields?.[0].value, '**9**/10 · Strong');
});
