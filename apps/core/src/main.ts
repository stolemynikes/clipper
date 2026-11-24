// npm start: job worker + review page + VOD watcher in one process.
import { loadSettings } from './config.ts';
import { openDb } from './db/client.ts';
import { checkHardware } from './hardware.ts';
import { logger } from './log.ts';
import { renderClip } from './modules/editor/clip-job.ts';
import { publishClip } from './modules/publisher/publish.ts';
import { askSubmit } from './modules/submitter/submit.ts';
import { trackOnce } from './modules/tracker/track.ts';
import { analyzeVod } from './modules/vod-clipper/analyze.ts';
import { watchOnce } from './modules/watcher/watcher.ts';
import { runWorker } from './queue/worker.ts';
import { alertFailure, bark, isPaused, notifyReview } from './review/review.ts';
import { judgeClip } from './modules/judge/judge.ts';
import { learnDue, learnOnce } from './modules/learner/weights.ts';
import { startReviewServer } from './review/server.ts';
import { titleClip } from './modules/publisher/titles.ts';
import { studyJob } from './modules/learner/study.ts';
import { scoutOnce } from './modules/scout/scout.ts';

const log = logger('main');
const { drift } = checkHardware();
for (const d of drift) log.warn(`hardware drift: ${d}`);

const db = openDb();
const server = startReviewServer(db);
const ac = new AbortController();

const watch = () => { if (!isPaused() && loadSettings().watcher.enabled !== false) watchOnce(db).catch((e) => log.error('watcher failed', { error: String(e) })); };
watch();
const timer = setInterval(watch, loadSettings().watcher.pollMinutes * 60_000);
const track = () => trackOnce(db).catch((e) => log.error('tracker failed', { error: String(e) }));
const trackTimer = setInterval(track, 60 * 60_000); // hourly: views move slowly, API quotas are small
const learn = () => {
  if (!learnDue()) return;
  try {
    const { next, changes } = learnOnce(db);
    log.info(`learner: ${next.n} clips, label ${next.label}, auc ${JSON.stringify(next.auc)}`);
    bark('Weekly learning', changes.length ? changes.join('\n') : `No weight changes (${next.n} clips, label: ${next.label}).`, { level: 'passive' }).catch(() => {});
  } catch (e) { log.error('learner failed', { error: String(e) }); }
};
learn();
const learnTimer = setInterval(learn, 24 * 60 * 60_000); // checks daily, runs weekly
const scout = () => { if (!isPaused() && loadSettings().scout?.enabled !== false) scoutOnce(db).catch((e) => log.error('scout failed', { error: String(e) })); };
const scoutTimer = setInterval(scout, 24 * 60 * 60_000); // daily: joins at most 3 new campaigns per run

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { ac.abort(); clearInterval(timer); clearInterval(trackTimer); clearInterval(learnTimer); clearInterval(scoutTimer); server.close(); });

const opts = { signal: ac.signal, paused: isPaused, onFinalFailure: alertFailure };
// Separate loops: a review push must not wait behind hours of heavy analyze/render jobs.
await Promise.all([
  runWorker(db, { 'vod.analyze': (p) => analyzeVod(db, p), 'clip.render': (p) => renderClip(db, p), 'clip.title': (p) => titleClip(db, p), 'campaign.study': (p) => studyJob(p), 'clip.judge': (p) => judgeClip(db, p) }, opts),
  runWorker(db, { 'review.notify': (p) => notifyReview(db, p) }, opts),
  runWorker(db, { 'clip.publish': (p) => publishClip(db, p), 'post.submit': (p) => askSubmit(db, p), 'post.track': () => trackOnce(db) }, opts),
]);
