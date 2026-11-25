import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isoSeconds } from '../../youtube.ts';
import { findSubs } from './short-analysis.ts';

test('isoSeconds parses YouTube durations', () => {
  assert.equal(isoSeconds('PT1M5S'), 65);
  assert.equal(isoSeconds('PT45S'), 45);
  assert.equal(isoSeconds('PT1H'), 3600);
  assert.equal(isoSeconds(''), 0);
});

// 16 bands x 40 frames; text amount per band given by fn(frame).
const frames = (bands: Record<number, (f: number) => number>) =>
  Array.from({ length: 40 }, (_, f) => Array.from({ length: 16 }, (_, b) => bands[b]?.(f) ?? 0));

test('changing text band = captions, steady band = title header', () => {
  const s = findSubs(frames({ 5: () => 0.2, 7: (f) => (f % 3 === 0 ? 0.05 : 0.03) }), 26);
  assert.equal(s.present, true);
  assert.equal(s.position, 'middle');
  assert.equal(s.header, true);
  assert.ok(s.wordsPerLine! > 0);
});

test('only a steady header: no captions', () => {
  const s = findSubs(frames({ 4: () => 0.2 }), 20);
  assert.equal(s.present, false);
  assert.equal(s.header, true);
});

test('game subtitles in the bottom band do not count', () => {
  assert.equal(findSubs(frames({ 15: (f) => (f % 2 ? 0.05 : 0) }), 20).present, false);
});
