import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../db/client.ts';
import { backoffMs, claim, enqueue, recoverStale, Stop } from './queue.ts';
import { runOnce } from './worker.ts';

test('claim returns due jobs once, in runAt order, filtered by type', () => {
  const db = openDb(':memory:');
  enqueue(db, 'b', { n: 1 });
  const a = enqueue(db, 'a', { n: 2 }, { runAt: new Date(Date.now() - 1000) });
  enqueue(db, 'a', { n: 3 }, { runAt: new Date(Date.now() + 60_000) });

  const first = claim(db, ['a']);
  assert.equal(first?.id, a.id);
  assert.equal(first?.status, 'running');
  assert.equal(first?.attempts, 1);
  assert.equal(claim(db, ['a']), undefined, 'future job is not due, claimed job not reclaimed');
});

test('failing job retries with backoff, then fails permanently and alerts', async () => {
  const db = openDb(':memory:');
  const job = enqueue(db, 'boom', {}, { maxAttempts: 2 });
  const alerts: number[] = [];
  const handlers = { boom: async () => { throw new Error('nope'); } };
  const opts = { onFinalFailure: (j: { id: number }) => { alerts.push(j.id); } };

  assert.equal(await runOnce(db, handlers, opts), true);
  assert.equal(await runOnce(db, handlers, opts), false, 'retry is scheduled in the future');
  assert.deepEqual(alerts, []);

  const statusOf = () => db.$client.prepare('select status, attempts, error from jobs where id=?').get(job.id);
  assert.deepEqual(statusOf(), { status: 'queued', attempts: 1, error: (statusOf() as { error: string }).error });

  // Fast-forward past the backoff.
  db.$client.prepare('update jobs set run_at=0 where id=?').run(job.id);
  await runOnce(db, handlers, opts);
  assert.equal((statusOf() as { status: string }).status, 'failed');
  assert.match((statusOf() as { error: string }).error, /nope/);
  assert.deepEqual(alerts, [job.id]);
});

test('Stop ends the job at once without retry or alert', async () => {
  const db = openDb(':memory:');
  const job = enqueue(db, 'halt', {}, { maxAttempts: 3 });
  const alerts: number[] = [];
  await runOnce(db, { halt: async () => { throw new Stop('campaign ended'); } }, { onFinalFailure: (j) => { alerts.push(j.id); } });
  assert.deepEqual(db.$client.prepare('select status, attempts, error from jobs where id=?').get(job.id), { status: 'failed', attempts: 1, error: 'campaign ended' });
  assert.deepEqual(alerts, []);
});

test('successful job is marked done', async () => {
  const db = openDb(':memory:');
  const job = enqueue(db, 'ok', { x: 1 });
  let seen: unknown;
  await runOnce(db, { ok: async (p) => { seen = p; } });
  assert.deepEqual(seen, { x: 1 });
  assert.deepEqual(db.$client.prepare('select status from jobs where id=?').get(job.id), { status: 'done' });
});

test('recoverStale requeues crashed running jobs', () => {
  const db = openDb(':memory:');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
  enqueue(db, 'x', {}, { runAt: twoHoursAgo });
  assert.ok(claim(db, ['x'], twoHoursAgo));
  assert.equal(recoverStale(db, 60 * 60_000), 1);
  assert.ok(claim(db, ['x']));
});

test('backoff grows and is capped', () => {
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 120_000);
  assert.equal(backoffMs(20), 2 * 60 * 60_000);
});
