import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatGaps, parseChat } from './analyze.ts';

test('parseChat maps TwitchDownloader comments', () => {
  assert.deepEqual(parseChat({ comments: [{ content_offset_seconds: 12.5, message: { body: 'KEKW' } }, { content_offset_seconds: 13 }] }),
    [{ t: 12.5, text: 'KEKW', user: '' }, { t: 13, text: '', user: '' }]);
  assert.deepEqual(parseChat({}), []);
});

test('chatGaps finds silent stretches, also at the start and end', () => {
  assert.deepEqual(chatGaps([700, 710, 5000.5, 5010], 6000), [[0, 700], [710, 5001], [5010, 6000]]);
  assert.deepEqual(chatGaps([10, 300, 590], 900), []);
});
