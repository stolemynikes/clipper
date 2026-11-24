import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAss, censorWord, chunkWords } from './subtitles.ts';

const words = [
  { w: 'no', s: 0.5, e: 0.8 },
  { w: 'way', s: 0.9, e: 1.2 },
  { w: '{\\b1}bro', s: 1.3, e: 1.6 },
  { w: 'what', s: 2.0, e: 2.4 },
];

test('one caption event per word, active word highlighted, markup stripped', () => {
  const ass = buildAss({ words, durationSec: 10, tag: '@Streamer', disclosure: '#ad' });
  const caps = ass.split('\n').filter((l) => l.includes(',Caption,'));
  assert.equal(caps.length, 4);
  assert.match(caps[0], /^Dialogue: 0,0:00:00.50,0:00:00.90,Caption.*\{\\c&H0015CCFA&?\}NO\{\\c&H00FFFFFF\} WAY B1BRO$/);
  assert.match(caps[2], /0:00:01.30,0:00:02.00/); // last word of chunk lasts until next chunk
  assert.ok(!caps[2].includes('\\b1'));
  assert.match(ass, /,Tag,.*@streamer$/m);
  assert.match(ass, /0:00:00.00,0:00:03.00,Disclosure,.*#AD$/m);
});

test('no disclosure when not required', () => {
  assert.ok(!buildAss({ words, durationSec: 10, tag: '@s', disclosure: null }).includes(',Disclosure,,'));
});

test('censor masks stems in captions only', () => {
  assert.equal(censorWord('fucking', ['fuck']), 'f******');
  assert.equal(censorWord('Shit!', ['shit']), 'S***!');
  assert.equal(censorWord('shitake', ['fuck']), 'shitake');
  const ass = buildAss({ words: [{ w: 'fuck', s: 0, e: 1 }], durationSec: 1, tag: '', censor: ['fuck'] });
  assert.ok(ass.includes('F***') && !ass.includes('FUCK'));
});

test('chat overlay: card with sender, fade, markup stripped', () => {
  const ass = buildAss({ words: [], durationSec: 10, tag: '', chat: [{ t: 1, s: 2, e: 6, user: 'bob', text: 'hi {\\b1}there' }] });
  const line = ass.split('\n').find((l) => l.includes(',Chat,'))!;
  assert.match(line, /^Dialogue: 0,0:00:02\.00,0:00:06\.00,Chat,/);
  assert.match(line, /\\fad\(150,150\)/);
  assert.match(line, /bob\{\\c&H00FFFFFF\}  hi b1there$/);
});

test('chunks split on max words, punctuation and pauses', () => {
  const w = (t: string, s: number) => ({ w: t, s, e: s + 0.2 });
  const join = (g: { w: string }[][]) => g.map((c) => c.map((x) => x.w).join(' '));
  assert.deepEqual(join(chunkWords([w('oh', 0), w('my', 0.3), w('god.', 0.6), w('what', 0.9)], 3)), ['oh my god.', 'what']);
  assert.deepEqual(join(chunkWords([w('wait', 0), w('no!', 0.3), w('stop', 0.6)], 3)), ['wait no!', 'stop']);
  assert.deepEqual(join(chunkWords([w('a', 0), w('b', 0.3), w('c', 2)], 3)), ['a b', 'c']);
  assert.deepEqual(join(chunkWords([w('a', 0), w('b', 0.3), w('c', 0.6), w('d', 0.9)], 2)), ['a b', 'c d']);
});

test('styles: font in style line, pop adds scale animation, clean uses a box', () => {
  const base = { words, durationSec: 5, tag: '' };
  assert.match(buildAss(base), /Style: Caption,Russo One,84,/);
  const pop = buildAss({ ...base, style: 'pop' });
  assert.match(pop, /Style: Caption,Archivo Black,/);
  assert.match(pop, /\\t\(0,70,\\fscx118\\fscy118\)/);
  assert.match(buildAss({ ...base, style: 'clean' }), /Style: Caption,Anton,96,.*,3,/);
});

test('hook burned in for the first seconds, braces stripped', () => {
  const ass = buildAss({ words, durationSec: 10, tag: '@Streamer', disclosure: '#ad', hook: 'He {did} WHAT?' });
  const line = ass.split('\n').find((l) => l.includes(',Hook,'))!;
  assert.ok(line.startsWith('Dialogue: 0,0:00:00.00,0:00:02.50,Hook,'));
  assert.ok(line.endsWith('HE DID WHAT?'));
  assert.ok(line.includes('{\\pos(540,470)\\fad(0,200)'));
  assert.ok(!buildAss({ words, durationSec: 10, tag: '@S', disclosure: null }).includes(',Hook,,'));
});
