// npm start: job worker + review page + VOD watcher in one process.
import { loadSettings } from './config.ts';
import { openDb } from './db/client.ts';
import { checkHardware } from './hardware.ts';
import { logger } from './log.ts';
import { renderClip } from './modules/editor/clip-job.ts';
import { analyzeVod } from './modules/vod-clipper/analyze.ts';
import { watchOnce } from './modules/watcher/watcher.ts';
import { runWorker } from './queue/worker.ts';
import { alertFailure, isPaused, notifyReview } from './review/review.ts';
import { startReviewServer } from './review/server.ts';

const log = logger('main');
const { drift } = checkHardware();
for (const d of drift) log.warn(`hardware drift: ${d}`);

const db = openDb();
const server = startReviewServer(db);
const ac = new AbortController();

const watch = () => { if (!isPaused()) watchOnce(db).catch((e) => log.error('watcher failed', { error: String(e) })); };
watch();
const timer = setInterval(watch, loadSettings().watcher.pollMinutes * 60_000);

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { ac.abort(); clearInterval(timer); server.close(); });

const opts = { signal: ac.signal, paused: isPaused, onFinalFailure: alertFailure };
// Separate loops: a review push must not wait behind hours of heavy analyze/render jobs.
await Promise.all([
  runWorker(db, { 'vod.analyze': (p) => analyzeVod(db, p), 'clip.render': (p) => renderClip(db, p) }, opts),
  runWorker(db, { 'review.notify': (p) => notifyReview(db, p) }, opts),
]);
