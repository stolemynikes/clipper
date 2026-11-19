import { setTimeout as sleep } from 'node:timers/promises';
import type { Db } from '../db/client.ts';
import { logger } from '../log.ts';
import { claim, complete, fail, recoverStale, type Job } from './queue.ts';

export type Handler = (payload: any, job: Job) => Promise<void>;

export interface WorkerOptions {
  pollMs?: number;
  staleMs?: number;
  signal?: AbortSignal;
  /** Called once a job has used its last attempt (Telegram alert in phase 1). */
  onFinalFailure?: (job: Job) => void | Promise<void>;
}

const log = logger('worker');

/** Processes one due job. Returns false when the queue had nothing to do. */
export async function runOnce(db: Db, handlers: Record<string, Handler>, opts: WorkerOptions = {}): Promise<boolean> {
  const job = claim(db, Object.keys(handlers));
  if (!job) return false;
  try {
    await handlers[job.type](job.payload, job);
    complete(db, job.id);
    log.info(`job ${job.id} (${job.type}) done`);
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const updated = fail(db, job, msg);
    if (updated.status === 'failed') {
      log.error(`job ${job.id} (${job.type}) failed permanently`, { error: msg });
      await opts.onFinalFailure?.(updated);
    } else {
      log.warn(`job ${job.id} (${job.type}) failed, attempt ${job.attempts}/${job.maxAttempts}, retry at ${updated.runAt.toISOString()}`);
    }
  }
  return true;
}

export async function runWorker(db: Db, handlers: Record<string, Handler>, opts: WorkerOptions = {}) {
  const recovered = recoverStale(db, opts.staleMs ?? 60 * 60_000);
  if (recovered) log.warn(`requeued ${recovered} stale running job(s)`);
  while (!opts.signal?.aborted) {
    if (!(await runOnce(db, handlers, opts))) await sleep(opts.pollMs ?? 2000, undefined, { signal: opts.signal }).catch(() => {});
  }
}
