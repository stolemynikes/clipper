import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitBlock } from './submit.ts';

test('submit: only once, inside 30 min, public, with a link', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const p = { url: 'https://youtube.com/shorts/x', submitted: false, postedAt: new Date(now.getTime() - 10 * 60_000), platform: 'youtube' };
  assert.equal(submitBlock(p, now, false), null);
  assert.equal(submitBlock({ ...p, submitted: true }, now, false), 'already asked once');
  assert.equal(submitBlock({ ...p, url: null }, now, false), 'no link yet');
  assert.equal(submitBlock({ ...p, postedAt: new Date(now.getTime() - 31 * 60_000) }, now, false), 'over 30 minutes after posting');
  assert.equal(submitBlock({ ...p, platform: 'tiktok' }, now, true), 'TikTok post is private');
  assert.equal(submitBlock({ ...p, platform: 'tiktok' }, now, false), null);
});
