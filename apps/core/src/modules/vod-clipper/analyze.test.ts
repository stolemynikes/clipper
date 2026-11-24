import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChat } from './analyze.ts';

test('parseChat maps TwitchDownloader comments', () => {
  assert.deepEqual(parseChat({ comments: [{ content_offset_seconds: 12.5, message: { body: 'KEKW' } }, { content_offset_seconds: 13 }] }),
    [{ t: 12.5, text: 'KEKW', user: '' }, { t: 13, text: '', user: '' }]);
  assert.deepEqual(parseChat({}), []);
});
