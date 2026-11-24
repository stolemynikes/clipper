import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackTitle, nextDay, postText } from './publish.ts';
import { chunk } from '../tracker/track.ts';

test('fallback title: first sentence, capped, no angle brackets', () => {
  assert.equal(fallbackTitle('oh my god he hit the shot. then he left', 'Clix'), 'Oh my god he hit the shot.');
  assert.equal(fallbackTitle('uh', 'Clix'), 'Clix moment');
  assert.equal(fallbackTitle(null, 'Clix'), 'Clix moment');
  const long = fallbackTitle('word '.repeat(40), 'Clix');
  assert.ok(long.length <= 71 && long.endsWith('…'));
  assert.ok(!fallbackTitle('look <script> at this one guys', 'Clix').includes('<'));
});

test('post text carries disclosure and tag on every platform', () => {
  const o = { title: 'He hit the shot', streamer: 'Clix', tag: '@Clix', disclosure: '#ad' };
  const yt = postText('youtube', o);
  assert.equal(yt.title, 'He hit the shot');
  assert.match(yt.description, /^#ad @Clix #Clix #shorts$/);
  assert.equal(postText('tiktok', o).title, 'He hit the shot #ad @Clix #Clix #fyp');
  assert.equal(postText('youtube', { ...o, title: 'x'.repeat(150) }).title.length, 100);
  assert.doesNotMatch(postText('tiktok', { ...o, disclosure: null }).title, /#ad/);
});

test('daily limit moves the post to tomorrow 10:00', () => {
  const d = nextDay(new Date(2026, 10, 30, 23, 30));
  assert.deepEqual([d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [11, 1, 10, 0]);
});

test('chunk splits for API batch limits', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 20), []);
});

test('handle check only sends valid names to YouTube', async () => {
  const { validHandle } = await import('../../review/setup.ts');
  assert.ok(validHandle('clix.clips.hq') && validHandle('dailyclixclips'));
  assert.ok(!validHandle('ab') && !validHandle('.dot') && !validHandle('a/b') && !validHandle('x'.repeat(31)) && !validHandle('a&key=x'));
});
