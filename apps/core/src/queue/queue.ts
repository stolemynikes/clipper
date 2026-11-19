import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { jobs } from '../db/schema.ts';

export type Job = typeof jobs.$inferSelect;

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
}

/** Exponential backoff: 30s, 2m, 8m, 32m ... capped at 2h. */
export const backoffMs = (attempt: number) => Math.min(30_000 * 4 ** (attempt - 1), 2 * 60 * 60_000);

export function enqueue(db: Db, type: string, payload: unknown, opts: EnqueueOptions = {}): Job {
  return db
    .insert(jobs)
    .values({ type, payload, runAt: opts.runAt ?? new Date(), maxAttempts: opts.maxAttempts ?? 3 })
    .returning()
    .get();
}

/**
 * Atomically claims the oldest due job of the given types.
 * A single UPDATE ... WHERE id = (SELECT ...) is atomic in SQLite, so two workers never get the same job.
 */
export function claim(db: Db, types: string[], now = new Date()): Job | undefined {
  if (types.length === 0) return undefined;
  const list = sql.join(types.map((t) => sql`${t}`), sql`, `);
  return db
    .update(jobs)
    .set({ status: 'running', lockedAt: now, attempts: sql`${jobs.attempts} + 1` })
    .where(
      eq(
        jobs.id,
        sql`(select ${jobs.id} from ${jobs} where ${jobs.status} = 'queued' and ${jobs.runAt} <= ${now.getTime()} and ${jobs.type} in (${list}) order by ${jobs.runAt} limit 1)`,
      ),
    )
    .returning()
    .get();
}

export function complete(db: Db, id: number) {
  db.update(jobs).set({ status: 'done', lockedAt: null, error: null }).where(eq(jobs.id, id)).run();
}

/** Requeues with backoff, or marks failed after the last attempt. Returns the updated job. */
export function fail(db: Db, job: Job, error: string, now = new Date()): Job {
  const final = job.attempts >= job.maxAttempts;
  return db
    .update(jobs)
    .set(
      final
        ? { status: 'failed', lockedAt: null, error }
        : { status: 'queued', lockedAt: null, error, runAt: new Date(now.getTime() + backoffMs(job.attempts)) },
    )
    .where(eq(jobs.id, job.id))
    .returning()
    .get();
}

/** Jobs left 'running' by a crashed process go back to the queue. */
export function recoverStale(db: Db, olderThanMs: number, now = new Date()): number {
  return db
    .update(jobs)
    .set({ status: 'queued', lockedAt: null })
    .where(and(eq(jobs.status, 'running'), lt(jobs.lockedAt, new Date(now.getTime() - olderThanMs))))
    .run().changes;
}

export function listJobs(db: Db, status?: Job['status']) {
  return db.select().from(jobs).where(status ? eq(jobs.status, status) : undefined).orderBy(asc(jobs.id)).all();
}
