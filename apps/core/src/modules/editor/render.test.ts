import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duckFilter, ffmpegArgs, filterGraph, quietMusic } from './render.ts';

test('facecam layout stacks 768 + 1152 = 1920 and burns subs', () => {
  const g = filterGraph({ cam: { x: 0.75, y: 0, w: 0.25, h: 0.25 } }, 'subs.ass', '../fonts');
  assert.match(g, /crop=iw\*0\.25:ih\*0\.25:iw\*0\.75:ih\*0/);
  assert.match(g, /scale=1080:768/);
  assert.match(g, /scale=1080:1152/);
  assert.match(g, /vstack,ass=subs\.ass:fontsdir=\.\.\/fonts\[v\]$/);
});

test('no facecam: plain center crop', () => {
  assert.equal(filterGraph({}, 's.ass', 'f'),
    '[0:v]crop=ih*9/16:ih,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,ass=s.ass:fontsdir=f[v]');
});

test('detected content rect replaces the center crop', () => {
  const g = filterGraph({ cam: { x: 0, y: 0.05, w: 0.35, h: 0.39 }, content: { x: 0.4, y: 0, w: 0.53, h: 1 } }, 's.ass', 'f');
  assert.match(g, /\[b\]crop=iw\*0\.53:ih\*1:iw\*0\.4:ih\*0,scale=1080:1152/);
  assert.match(filterGraph({ content: { x: 0.3, y: 0, w: 0.32, h: 1 } }, 's.ass', 'f'), /^\[0:v\]crop=iw\*0\.32:ih\*1:iw\*0\.3:ih\*0,scale=1080:1920/);
});

test('encoder choice', () => {
  assert.ok(ffmpegArgs('i', 'o', 'g', 'h264_nvenc').includes('h264_nvenc'));
  assert.ok(ffmpegArgs('i', 'o', 'g', 'libx264').includes('libx264'));
});

test('nocam: whole content on a blurred background, centered', () => {
  const g = filterGraph({ scene: 'nocam', content: { x: 0.1, y: 0, w: 0.75, h: 1 } }, 's.ass', 'f');
  assert.match(g, /boxblur/);
  assert.match(g, /\[b\]crop=iw\*0\.75:ih\*1:iw\*0\.1:ih\*0,scale=1080:-2/);
  assert.match(g, /overlay=0:\(H-h\)\/2,ass=s\.ass:fontsdir=f\[v\]$/);
});

test('trim: seek to the start and cut to the length', () => {
  assert.deepEqual(ffmpegArgs('i', 'o', 'g', 'libx264', 11.5).slice(4, 8), ['-ss', '11.50', '-i', 'i']);
  assert.deepEqual(ffmpegArgs('i', 'o', 'g', 'libx264', 11.5, null, 30).slice(4, 10), ['-ss', '11.50', '-t', '30.00', '-i', 'i']);
});

test('cam + static screen: whole frame on blur below the cam', () => {
  const g = filterGraph({ scene: 'cam', cam: { x: 0, y: 0, w: 0.2, h: 0.2 }, content: { x: 0, y: 0, w: 1, h: 1 }, fit: 'full' }, 's.ass', 'f');
  assert.match(g, /\[c\]scale=1080:1152.*boxblur/);
  assert.match(g, /\[d\]crop=iw\*1:ih\*1:iw\*0:ih\*0,scale=1080:-2/);
  assert.match(g, /\[top\]\[bot\]vstack/);
});

test('music ducking: only where nobody talks', () => {
  const words = [{ s: 2, e: 3 }, { s: 3.2, e: 4 }, { s: 10, e: 11 }];
  assert.deepEqual(quietMusic([[0, 12]], words), [[0, 1.7], [4.3, 9.7], [11.3, 12]]);
  assert.deepEqual(quietMusic([[2.5, 3.5]], words), []);
  assert.equal(duckFilter([]), null);
  assert.equal(duckFilter([[0, 1.7]]), "volume=0.25:enable='between(t,0.00,1.70)'");
  assert.ok(ffmpegArgs('a', 'b', 'g', 'libx264', 0, 'volume=0.25').join(' ').includes('-af volume=0.25'));
});

test('twitch chat layer: second input, faded and delayed, under the captions', () => {
  const g = filterGraph({ cam: { x: 0, y: 0, w: 0.2, h: 0.2 } }, 's.ass', 'f', { at: 12.5, dur: 9, x: 30, y: 1000 });
  assert.match(g, /vstack\[pre\];\[1:v\]fade=in:st=0:d=0\.2:alpha=1,fade=out:st=8\.70:d=0\.3:alpha=1,setpts=PTS\+12\.50\/TB\[ch\];\[pre\]\[ch\]overlay=30:1000:eof_action=pass,ass=s\.ass:fontsdir=f\[v\]$/);
  const a = ffmpegArgs('in.mp4', 'out.mp4', g, 'libx264', 5, null, 30, 'chat.mov');
  assert.deepEqual(a.slice(a.indexOf('-i'), a.indexOf('-filter_complex')), ['-i', 'in.mp4', '-i', 'chat.mov']);
  assert.ok(a.indexOf('-ss') < a.indexOf('-i')); // seek applies to the clip source only
});
