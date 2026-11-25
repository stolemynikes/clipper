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
});
