import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { askVisual, captionTimes } from './judge.ts';

test('captionTimes takes mid-points of Caption events only, spread to 4', () => {
  const f = join(tmpdir(), 'pair-test.ass');
  const ev = (s: number, style = 'Caption') => `Dialogue: 0,0:00:${String(s).padStart(2, '0')}.00,0:00:${String(s + 1).padStart(2, '0')}.00,${style},,0,0,0,,x`;
  writeFileSync(f, [ev(0, 'Hook'), ...Array.from({ length: 10 }, (_, i) => ev(i * 2))].join('\n'));
  assert.deepEqual(captionTimes(f), [2.5, 6.5, 10.5, 16.5]);
  assert.deepEqual(captionTimes(join(tmpdir(), 'missing.ass')), []);
});

test('screen score is skipped while unweighted, except 1 in 5 clips', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 10].map((id) => askVisual(id, 0)), [false, false, false, false, true, true]);
  assert.equal(askVisual(3, 0.2), true);
});
