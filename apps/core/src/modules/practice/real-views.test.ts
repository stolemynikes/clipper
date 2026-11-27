import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Proposal } from './proposals.ts';
import { beforeAfter, type PostViews } from './real-views.ts';

const day = 86_400_000, at = 100 * day;
const prop = (change: Proposal['change'], status: Proposal['status'] = 'approved'): Proposal =>
  ({ id: 'x', title: 'x', why: '', change, status, decided: at, created: 0, pairs: [], aa: [], frames: [] });
const row = (postedAt: number, views: number, streamer = 'lacy', kind: PostViews['kind'] = 'gaming'): PostViews => ({ kind, streamer, postedAt, views });

test('median views before vs after go-live, only own kind, only 14 days around it', () => {
  const rows = [row(at - 20 * day, 9999), row(at - 2 * day, 100), row(at - day, 300), row(at - 3 * day, 200), row(at + day, 500), row(at + 2 * day, 700), row(at + day, 5, 'x', 'talk')];
  assert.deepEqual(beforeAfter(prop({ maxLen: 20 }), rows), { before: { n: 3, median: 200 }, after: { n: 2, median: 600 }, enough: 5 });
});

test('per-streamer change counts only that streamer; not approved = nothing', () => {
  const rows = [row(at + day, 500), row(at + day, 50, 'silky')];
  assert.deepEqual(beforeAfter(prop({ gameCrop: { lacy: { x: 0, y: 0, w: 1, h: 1 } } }), rows)!.after, { n: 1, median: 500 });
  assert.equal(beforeAfter(prop({}, 'ready'), rows), null);
});
