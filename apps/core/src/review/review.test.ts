import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from './server.ts';

test('range header: open, closed, suffix, invalid', () => {
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=0-1', 1000), { start: 0, end: 1 });
  assert.deepEqual(parseRange('bytes=500-5000', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('bytes=2000-', 1000), null);
  assert.equal(parseRange('bytes=-', 1000), null);
});

test('auto-keep: needs viewer clips AND chat, no warnings, never loudness alone', async () => {
  const { autoKeep } = await import('./review.ts');
  const cfg = { enabled: true, minViewerClips: 5, minChatRate: 1 };
  assert.equal(autoKeep({ viewerClipHits: 7, chatRate: 1.9 }, [], cfg), true);
  assert.equal(autoKeep({ viewerClipHits: 7, chatRate: 1.9 }, ['Some background music'], cfg), false);
  assert.equal(autoKeep({ viewerClipHits: 9, chatRate: -0.1 }, [], cfg), false);
  assert.equal(autoKeep({ viewerClipHits: 0, chatRate: 9, audioPeak: 5 }, [], cfg), false);
  assert.equal(autoKeep({ viewerClipHits: 7, chatRate: 2, website: 1 }, [], cfg), false);
  assert.equal(autoKeep({ viewerClipHits: 7, chatRate: 2 }, [], { ...cfg, enabled: false }), false);
  assert.equal(autoKeep({ viewerClipHits: 7, chatRate: 2 }, [], undefined), false);
});

test('reasons: plain language, fallback when no signal stands out', async () => {
  const { reasons } = await import('./server.ts');
  assert.deepEqual(reasons({ viewerClipHits: 2, chatRate: 3, emoteScore: 1.5 }), ['2 viewers clipped this moment', 'Chat went wild', 'Lots of laughing and hype emotes']);
  assert.deepEqual(reasons({ viewerClipHits: 1, website: 1 }), ['1 viewer clipped this moment', 'Mostly a website on screen, so rated lower']);
  assert.deepEqual(reasons({ viewerClipHits: 1, chatRate: 1.2 }), ['1 viewer clipped this moment', 'Chat got busy']);
  assert.deepEqual(reasons({}), ['Picked by the tool as a highlight']);
});

test('rating: 1-10 relative to the best moment of the stream', async () => {
  const { rating } = await import('./review.ts');
  assert.equal(rating(11.3, 11.3), 10);
  assert.equal(rating(5, 10), 5);
  assert.equal(rating(-2, 10), 1);
  assert.equal(rating(3, 0), 5);
});

test('alertSeen: same error within 10 minutes alerts once', async () => {
  const { alertSeen } = await import('./review.ts');
  assert.equal(alertSeen('t|x', 0), false);
  assert.equal(alertSeen('t|x', 60_000), true);
  assert.equal(alertSeen('t|y', 60_000), false);
  assert.equal(alertSeen('t|x', 11 * 60_000), false);
});
