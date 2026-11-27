import assert from 'node:assert/strict';
import { test } from 'node:test';
import { footagePick } from '../vod-clipper/analyze.ts';
import { dropboxDirect, footageLinks } from './footage.ts';

const cfg = { windowSec: 5, leadInSec: [30, 60] as [number, number], weights: { chatRate: 1, emoteScore: 0.8, viewerClipHits: 2, audioPeak: 0.5 }, emotes: {} };
const limits = { minSec: 15, maxSec: 60 };

test('footageLinks finds Drive and Dropbox links, nothing else', () => {
  assert.deepEqual(footageLinks('Videos: https://drive.google.com/drive/folders/1AbC-d_9xYz?usp=sharing. Thanks'), ['https://drive.google.com/drive/folders/1AbC-d_9xYz']);
  assert.deepEqual(footageLinks('see https://drive.google.com/file/d/xyz1234567/view'), ['https://drive.google.com/file/d/xyz1234567']);
  assert.deepEqual(footageLinks('"https://www.dropbox.com/scl/fo/abc/def?rlkey=k&dl=0"'), ['https://www.dropbox.com/scl/fo/abc/def?rlkey=k&dl=0']);
  assert.deepEqual(footageLinks('overlays https://drive.google.com/drive/folders/A1b2c3d4e5f6 footage https://www.dropbox.com/s/b2/x.mp4 again https://drive.google.com/drive/folders/A1b2c3d4e5f6&service=x'),
    ['https://drive.google.com/drive/folders/A1b2c3d4e5f6', 'https://www.dropbox.com/s/b2/x.mp4']);
  assert.deepEqual(footageLinks('https://frame.io/x and https://mega.nz/y'), []);
  assert.equal(dropboxDirect('https://www.dropbox.com/scl/fo/abc?rlkey=k&dl=0'), 'https://www.dropbox.com/scl/fo/abc?rlkey=k&dl=1');
});

test('footagePick: short video whole, too short nothing, long video by loudness', () => {
  assert.deepEqual(footagePick(42, [], cfg, limits).map((m) => [m.start, m.end]), [[0, 42]]);
  assert.deepEqual(footagePick(5, [], cfg, limits), []);
  const audio = Array.from({ length: 1200 / 5 }, (_, i) => (i === 100 || i === 200 ? -5 : -40)); // loud at 500s and 1000s
  const picked = footagePick(1200, audio, cfg, limits);
  assert.ok(picked.length >= 1 && picked.length <= 2, String(picked.length));
  for (const m of picked) assert.ok(m.end - m.start <= 60 && m.end - m.start >= 15);
  assert.ok(picked.some((m) => m.start <= 500 && m.end >= 500));
});
