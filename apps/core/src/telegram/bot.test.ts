import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrammyError } from 'grammy';
import { reviewCaption, withRateLimit } from './bot.ts';

test('review caption links VOD timestamp and escapes html', () => {
  const c = reviewCaption({ streamer: 'a<b', url: 'https://www.twitch.tv/videos/1', startSec: 3725, durationSec: 42.4, score: 7.25, signals: { chatRate: 3.2, emoteScore: 1, viewerClipHits: 2 } });
  assert.match(c, /<b>a&lt;b<\/b> · 42s · score <b>7\.3<\/b>/);
  assert.match(c, /videos\/1\?t=3725s">VOD @ 01:02:05/);
  assert.match(c, /viewer clips 2/);
});

test('withRateLimit retries after a 429 and rethrows other errors', async () => {
  let n = 0;
  const e429 = new GrammyError('x', { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } }, 'sendVideo', {});
  assert.equal(await withRateLimit(async () => (n++ === 0 ? Promise.reject(e429) : 'ok')), 'ok');
  await assert.rejects(withRateLimit(async () => { throw new Error('boom'); }), /boom/);
});
