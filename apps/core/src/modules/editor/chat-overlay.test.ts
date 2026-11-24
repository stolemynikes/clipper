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
