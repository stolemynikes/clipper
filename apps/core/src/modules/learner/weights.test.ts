import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auc, learnStep, MIN_N, nextWeight } from './weights.ts';
import { funBonus } from '../judge/judge.ts';

test('auc: perfect, inverse, ties, one class empty', () => {
  assert.equal(auc([3, 4, 1, 2], [true, true, false, false]), 1);
  assert.equal(auc([1, 2, 3, 4], [true, true, false, false]), 0);
  assert.equal(auc([1, 1], [true, false]), 0.5);
  assert.equal(auc([1, 2], [true, true]), null);
});

test('nextWeight: needs MIN_N, weak signal goes to 0, max 1 step, capped at 5', () => {
  assert.equal(nextWeight(0, 0.9, MIN_N - 1), 0);
  assert.equal(nextWeight(0, null, 100), 0);
  assert.equal(nextWeight(0, 0.9, MIN_N), 1); // target 5, one step
  assert.equal(nextWeight(4.5, 0.9, MIN_N), 5);
  assert.equal(nextWeight(3, 0.55, MIN_N), 2); // below 0.6: drift down, one step
  assert.equal(nextWeight(1.5, 0.6, MIN_N), 2); // target 2
});

test('learnStep: owner decisions beat proxy; auto-kept clips and unjudged clips are ignored', () => {
  const rows = Array.from({ length: 24 }, (_, i) => ({
    signals: JSON.stringify({ laughMax: i < 12 ? 0.5 : 0, viewerClipHits: i % 3, speech: 0.5 }),
    status: i < 12 ? 'approved' : 'rejected', views: null,
  }));
  const { next, changes } = learnStep([...rows, { signals: '{"autoKept":1,"speech":1}', status: 'approved', views: null }, { signals: '{}', status: 'rejected', views: null }], null);
  assert.equal(next.label, 'owner Keep/Skip');
  assert.equal(next.n, 24);
  assert.equal(next.auc.laughMax, 1);
  assert.equal(next.weights.laughMax, 1);
  assert.equal(next.weights.speech, 0); // no signal (all equal): stays 0
  assert.deepEqual(changes, ['laughMax 0 -> 1 (AUC 1, 24 clips)']);
});

test('learnStep: proxy label never scores viewerClipHits against itself; views win when there are enough', () => {
  const few = [{ signals: '{"speech":0.2,"viewerClipHits":1}', status: 'pending_review', views: null }, { signals: '{"speech":0.9,"viewerClipHits":5}', status: 'pending_review', views: null }];
  assert.equal(learnStep(few, null).next.label, 'viewers clipped it (proxy)');
  assert.equal(learnStep(few, null).next.auc.viewerClipHits, undefined);
  const viewed = Array.from({ length: 20 }, (_, i) => ({ signals: JSON.stringify({ visual: i / 20 }), status: 'posted', views: i * 100 }));
  assert.equal(learnStep(viewed, null).next.label, 'views of our posts');
  assert.equal(learnStep(viewed, null).next.auc.visual, 1);
});

test('funBonus: unproven weights add nothing', () => {
  assert.equal(funBonus({ speech: 0.8, laughMax: 0.5 }, {}), 0);
  assert.equal(funBonus({ speech: 0.8, laughMax: 0.5 }, { speech: 2, laughMax: 1 }), 2.1);
});
