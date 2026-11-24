import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchChat } from './chat-overlay.ts';

const say = (text: string, from: number) => text.split(' ').map((w, i) => ({ w, s: from + i * 0.3, e: from + i * 0.3 + 0.25 }));

test('message read out loud becomes an overlay just before he reads it', () => {
  const o = matchChat(say('okay chat says your aim looks terrible today', 10), [
    { t: 8, user: 'bob', text: 'your aim looks terrible today' },
    { t: 9, user: 'amy', text: 'LUL' },
  ]);
  assert.equal(o.length, 1);
  assert.equal(o[0].user, 'bob');
  assert.ok(o[0].s >= 8 && o[0].s < 11);
});

test('saying the username matches, digits and underscores ignored', () => {
  const o = matchChat(say('thanks zacky for the sub', 20), [{ t: 18, user: 'Zacky_123', text: 'W stream' }]);
  assert.equal(o.length, 1);
});

test('no reaction, reaction too late, or a link: no overlay', () => {
  assert.equal(matchChat(say('random talk about the game', 5), [{ t: 4, user: 'bob', text: 'nice shot man' }]).length, 0);
  assert.equal(matchChat(say('nice shot man really', 40), [{ t: 4, user: 'bob', text: 'nice shot man' }]).length, 0);
  assert.equal(matchChat(say('check bob link', 5), [{ t: 4, user: 'bobby', text: 'https://x.y bobby' }]).length, 0);
});

test('max overlays, no overlap in time, sorted by time', () => {
  const words = [...say('hey alpha', 2), ...say('hey bravo', 3), ...say('hey charlie', 20), ...say('hey delta', 40)];
  const chat = ['alpha', 'bravo', 'charlie', 'delta'].map((u, i) => ({ t: [1, 2, 19, 39][i], user: u, text: 'hi' }));
  const o = matchChat(words, chat, 3);
  assert.equal(o.length, 3);
  assert.deepEqual(o.map((x) => x.user), ['alpha', 'charlie', 'delta']);
});

test('burst: busy peak gives a stacked feed without bots, commands or links; quiet chat gives none', async () => {
  const { burstChat } = await import('./chat-overlay.ts');
  const m = (t: number, text: string, user = `u${t}`) => ({ t, text, user });
  const wild = [m(40, 'NOWAY'), m(40.2, '!clip'), m(40.4, 'LOL', 'Nightbot'), m(40.5, 'go to x.com'), m(41, '???'), m(41.5, 'KEKW'),
    m(42, 'he did not'), m(42.5, 'OMEGALUL'), m(43, 'W'), m(43.5, 'a'.repeat(60)), m(50, 'late'), m(0, 'hi'), m(20, 'yo')];
  const b = burstChat(wild, 40, 47);
  assert.deepEqual(b.map((x) => x.row), [0, 1, 2, 3, 4]);
  assert.ok(b.every((x) => x.e === 48.5 && !/clip|Nightbot|x\.com|late/.test(x.text + x.user)));
  assert.deepEqual(b.map((x) => x.s), [40, 41, 41.5, 42, 42.5]);
  assert.equal(burstChat(wild.slice(0, 4), 40, 47).length, 0);
  // Same rate all through the moment: chat is just busy, not going wild.
  const steady = Array.from({ length: 60 }, (_, i) => m(i, `msg ${i}`));
  assert.equal(burstChat(steady, 40, 47).length, 0);
});
