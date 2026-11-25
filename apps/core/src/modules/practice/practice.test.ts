import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextState, pickVod, type State } from './practice.ts';

const s0: State = { fails: 0, retried: false, pauseUntil: 0, morning: '' };

test('3 failures pause once, the next 3 stop, a success resets', () => {
  let s = s0, a;
  for (let i = 0; i < 2; i++) ({ s, action: a } = nextState(s, false, 0)), assert.equal(a, 'none');
  ({ s, action: a } = nextState(s, false, 1000)); assert.equal(a, 'pause'); assert.equal(s.pauseUntil, 1000 + 3_600_000);
  for (let i = 0; i < 2; i++) ({ s, action: a } = nextState(s, false, 0)), assert.equal(a, 'none');
  ({ s, action: a } = nextState(s, false, 0)); assert.equal(a, 'stop');
  ({ s } = nextState({ ...s0, fails: 2, retried: true }, true, 0)); assert.deepEqual([s.fails, s.retried], [0, false]);
});

test('pickVod: 3-14 days old, unseen, most views', () => {
  const now = Date.UTC(2026, 10, 25), d = (n: number) => new Date(now - n * 86_400_000).toISOString();
  const v = (id: string, age: number, views: number) => ({ id, user_id: '1', user_login: 'x', title: '', created_at: d(age), duration: '1h', url: `u${id}`, view_count: views });
  const vods = [v('new', 1, 9999), v('old', 20, 9999), v('seen', 5, 5000), v('a', 4, 100), v('b', 10, 300)];
  assert.equal(pickVod(vods, new Set(['useen']), now)?.id, 'b');
  assert.equal(pickVod([v('new', 1, 1)], new Set(), now), undefined);
});
