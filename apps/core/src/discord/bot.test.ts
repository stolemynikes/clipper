import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamerConfig } from '../config.ts';
import { infoText, statsText } from './bot.ts';

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

test('info: rate, tag, link, under the message limit', () => {
  const s = { name: 'lacy', channel: 'lacy', tag: '@lacy', campaign: { platform: 'contentrewards', ratePer1k: 1, maxPerClip: 100, endsAt: '2026-12-31', url: 'https://contentrewards.com/c/campaigns/x', rules: { hashtags: ['#Lacy'] } } } as unknown as StreamerConfig;
  const t = infoText(s, new Date('2026-11-24'));
  assert.match(t, /\$1 per 1,000 views, at most \$100 per clip/);
  assert.match(t, /Tag: @lacy/);
  assert.match(t, /#Lacy/);
  assert.ok(t.endsWith('https://contentrewards.com/c/campaigns/x') && t.length <= 2000);
});
