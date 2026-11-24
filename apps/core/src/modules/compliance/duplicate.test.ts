import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlap } from './duplicate.ts';

const a = 'oh my god he is one shot he is one shot go go go I hit him for one fifty and he still fights back no way chat';

test('same speech with small Whisper differences matches', () => {
  assert.ok(overlap(a, 'Oh my god, he is one shot! He is one shot, go go go. I hit him for 150 and he still fights back, no way chat') >= 0.5);
});

test('a clip that is part of a longer one matches', () => {
  assert.ok(overlap(a.split(' ').slice(0, 14).join(' '), `${a} and then we rotate to the zone and take the fight on top`) >= 0.5);
});

test('different moments and too little speech do not match', () => {
  assert.ok(overlap(a, 'okay chat we are going to drop tilted and see what happens with the new shotgun today') < 0.5);
  assert.equal(overlap('go go go', 'go go go'), 0);
});
