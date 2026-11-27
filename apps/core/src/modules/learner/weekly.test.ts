import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genericHashtags } from './weekly.ts';

test('generic hashtags: 3+ Shorts from 2+ channels, no channel or streamer names', () => {
  const s = (channel: string, hashtags: string[]) => ({ channel, hashtags });
  const shorts = [
    s('A', ['#gaming', '#KaiCenat', '#shorts', '#funny']), s('A', ['#gaming', '#kaicenat', '#funny']),
    s('ChannelB', ['#Gaming', '#kaicenat', '#ChannelB']), s('ChannelB', ['#channelb', '#channelb', '#funny']), s('C', ['#channelb']),
  ];
  assert.deepEqual(genericHashtags(shorts, ['kaicenat']), ['#gaming', '#funny']);
  const games = [s('A', ['#leagueoflegends', '#twitch']), s('B', ['#leagueoflegends', '#twitch']), s('C', ['#leagueoflegends', '#twitch'])];
  assert.deepEqual(genericHashtags(games), ['#twitch']); // game tags mislead on other games' clips
});

test('peakWindow finds the busiest US-East 5h window, or null when weak', async () => {
  const { peakWindow, sourceShare } = await import('./weekly.ts');
  assert.deepEqual(peakWindow([14, 15, 15, 16, 17, 14, 15, 16, 2, 22]), [8, 13]); // ties pick the earliest window: 8am-1pm ET holds all 8 of 14-17 UTC
  assert.equal(peakWindow([0, 2, 5, 7, 10, 12, 15, 17, 20, 22]), null);
  assert.equal(peakWindow([14, 15]), null);
  assert.equal(sourceShare(['Clip from: twitch.tv/x', 'subscribe']), 0.5);
});
