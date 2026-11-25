import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { paths } from '../env.ts';
import { applySetting, FIELDS, getSettings, parseValue } from './settings.ts';

const yml = '# top note\nlimits:\n  maxPostsPerAccountPerDay: 3 # keep low\nclip:\n  minSec: 10\n  maxSec: 60\n  targetSec: [12, 26]\nplatforms:\n  tiktok: false\n';

test('every field exists in the real settings.yaml', () => {
  const real = getSettings(readFileSync(join(paths.configDir, 'settings.yaml'), 'utf8'));
  assert.deepEqual(real.filter((f) => f.value === null).map((f) => f.key), []);
});

test('write keeps comments and sets numbers, bools and array items', () => {
  let out = applySetting(yml, 'limits.maxPostsPerAccountPerDay', '5');
  out = applySetting(out, 'platforms.tiktok', 'true');
  out = applySetting(out, 'clip.targetSec.1', '30');
  assert.match(out, /# top note/);
  assert.match(out, /# keep low/);
  const v = parse(out);
  assert.equal(v.limits.maxPostsPerAccountPerDay, 5);
  assert.equal(v.platforms.tiktok, true);
  assert.deepEqual(v.clip.targetSec, [12, 30]);
});

test('bad values are refused', () => {
  assert.throws(() => parseValue('limits.maxPostsPerAccountPerDay', '0'), /1 to 20/);
  assert.throws(() => parseValue('limits.maxPostsPerAccountPerDay', ''), /number/);
  assert.throws(() => parseValue('limits.maxPostsPerAccountPerDay', 'abc'), /number/);
  assert.throws(() => parseValue('platforms.tiktok', 'yes'), /on or off/);
  assert.throws(() => parseValue('clip.captionStyle', 'comic'), /Pick one/);
  assert.throws(() => parseValue('queue.secret', '1'), /Unknown/);
  assert.throws(() => applySetting(yml.replace('maxSec: 60', 'maxSec: 40'), 'clip.minSec', '50'), /more than/);
  assert.throws(() => applySetting(yml, 'clip.maxSec', '9'), /from 10/);
  assert.throws(() => applySetting(yml.replace('minSec: 10', 'minSec: 30'), 'clip.maxSec', '20'), /less than/);
  assert.throws(() => applySetting(yml, 'clip.targetSec.0', '30'), /more than/);
  assert.equal(parseValue('scoring.weights.emoteScore', '0.33'), 0.35);
  assert.equal(parseValue('limits.maxPostsPerAccountPerDay', '4.6'), 5);
});

test('keys are unique', () => assert.equal(new Set(FIELDS.map((f) => f.key)).size, FIELDS.length));
