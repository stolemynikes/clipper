import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rating } from '../../review/review.ts';
import { LAYOUT_PREFIX, layoutPrompt, layoutResult, layoutRules } from './layout.ts';

const presets = {
  base: [{ id: 'head-cut', penalty: 3, check: 'Whole head visible.' }, { id: 'cam-twice', penalty: 2, check: 'No webcam in the game.' }],
  'content-rewards': [{ id: 'tag-place', penalty: 1, check: 'Tag bottom-right.' }],
  other: [{ id: 'x', penalty: 1, check: 'X.' }],
};
const camp = { platform: 'cr', ratePer1k: 1, maxPerClip: 100, endsAt: '2099-01-01' };

test('presets: base + content-rewards by default, own preset, brief rules', () => {
  assert.deepEqual(layoutRules(undefined, presets).map((r) => r.id), ['head-cut', 'cam-twice']);
  assert.deepEqual(layoutRules(camp, presets).map((r) => r.id), ['head-cut', 'cam-twice', 'tag-place']);
  const r = layoutRules({ ...camp, rulePreset: 'other', judgeRules: ['Show the logo.'] }, presets);
  assert.deepEqual(r.map((x) => x.id), ['head-cut', 'cam-twice', 'x', 'brief-1']);
  assert.equal(r[3].check, 'Show the logo.');
});

test('broken rules: penalty sum, plain warnings, unknown ids and repeats dropped', () => {
  const rules = layoutRules(camp, presets);
  const r = layoutResult([{ id: 'head-cut', why: 'The top of his head is cut off.' }, { id: 'head-cut', why: 'again' }, { id: 'made-up', why: '?' }, { id: 'cam-twice', why: '' }], rules);
  assert.equal(r.penalty, 5);
  assert.deepEqual(r.warnings, [`${LAYOUT_PREFIX}The top of his head is cut off.`, `${LAYOUT_PREFIX}No webcam in the game.`]);
  assert.deepEqual(layoutResult([], rules), { penalty: 0, warnings: [] });
});

test('rating: layout penalty lowers it, never below 1', () => {
  assert.equal(rating(10, 10, 3), 7);
  assert.equal(rating(2, 10, 5), 1);
});

test('brief notes: content notes become rules, posting/paying notes are skipped', () => {
  const c = { ...camp, rules: { notes: ['JasonTheWeen must be the main focus of the clip', 'No logos, no negative or hate-farm clips', 'Submit within 30 minutes of posting'] } };
  const r = layoutRules(c, presets).filter((x) => x.id.startsWith('note-'));
  assert.deepEqual(r.map((x) => x.check), ['JasonTheWeen must be the main focus of the clip', 'No logos, no negative or hate-farm clips']);
  assert.equal(r[0].penalty, 2);
});

test('footage prompts: brand video wording, stream wording stays without a focus', async () => {
  const { speechPrompt, footageVisualPrompt } = await import('./judge.ts');
  assert.match(speechPrompt('hi', [], 'the chorus'), /brand's own video[\s\S]*the chorus/);
  assert.doesNotMatch(speechPrompt('hi', []), /brand's own video/);
  assert.match(footageVisualPrompt('the chorus'), /the chorus/);
  assert.match(layoutPrompt([], '', true), /brand's own video/);
});
