import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveConfig, type Hardware } from './hardware.ts';

const base: Hardware = {
  gpu: { name: 'NVIDIA GeForce RTX 5070', vramMiB: 12227, driver: '610.88' },
  ramGB: 32,
  cpu: { name: 'Ryzen 7 5800X', cores: 8, threads: 16 },
  nvenc: ['h264_nvenc'],
  workDrive: { letter: 'E', freeGB: 411, mediaType: 'HDD' },
};

test('12GB NVENC GPU gets large-v3, nvenc, 2 renders, HDD warning', () => {
  const c = deriveConfig(base, 'E:\\dev\\clipping-tool\\data');
  assert.equal(c.whisperModelVod, 'large-v3');
  assert.equal(c.whisperModelLive, 'large-v3-turbo');
  assert.equal(c.encoder, 'h264_nvenc');
  assert.equal(c.maxParallelRenders, 2);
  assert.deepEqual(c.warnings, ['E: is an HDD: downloads and renders will be I/O bound']);
});

test('small GPU without NVENC and low disk falls back and warns', () => {
  const c = deriveConfig(
    { ...base, gpu: { name: 'x', vramMiB: 6144, driver: '1' }, nvenc: [], workDrive: { letter: 'E', freeGB: 50, mediaType: 'SSD' } },
    'E:\\data',
  );
  assert.equal(c.whisperModelVod, 'medium');
  assert.equal(c.encoder, 'libx264');
  assert.equal(c.maxParallelRenders, 2);
  assert.equal(c.warnings.length, 2);
});

test('workDir off E: is flagged', () => {
  assert.match(deriveConfig(base, 'C:\\data').warnings[0], /not on E:/);
});
