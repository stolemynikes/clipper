import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelUrl, usable } from './youtube.ts';

test('channelUrl takes a channel id, @handle or bare handle', () => {
  assert.equal(channelUrl('UC' + 'a'.repeat(22)), `https://www.youtube.com/channel/UC${'a'.repeat(22)}/videos`);
  assert.equal(channelUrl('@flagrant'), 'https://www.youtube.com/@flagrant/videos');
  assert.equal(channelUrl('flagrant'), 'https://www.youtube.com/@flagrant/videos');
});

test('usable skips Shorts, live, upcoming and bad ids', () => {
  assert.equal(usable({ id: 'abcdefghijk', duration: 3600 }), true);
  assert.equal(usable({ id: 'abcdefghijk', duration: 50 }), false);
  assert.equal(usable({ id: 'abcdefghijk', duration: 3600, live_status: 'is_live' }), false);
  assert.equal(usable({ id: 'bad', duration: 3600 }), false);
});
