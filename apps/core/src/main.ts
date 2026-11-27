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
import { watchFootage } from './modules/watcher/footage.ts';
import { watchYoutube } from './modules/watcher/youtube.ts';
import { watchOnce } from './modules/watcher/watcher.ts';
import { runWorker } from './queue/worker.ts';
import { alertFailure, bark, isOff, isPaused, notifyReview } from './review/review.ts';
import { judgeClip } from './modules/judge/judge.ts';
import { learnDue, learnOnce } from './modules/learner/weights.ts';
import { startReviewServer } from './review/server.ts';
import { titleClip } from './modules/publisher/titles.ts';
import { studyJob } from './modules/learner/study.ts';
import { weeklyDue, weeklyShorts } from './modules/learner/weekly.ts';
import { enqueue, recoverStale } from './queue/queue.ts';
import { classifyJob, discoverAll, joinJob, scoutOnce } from './modules/scout/scout.ts';
import { isPractice, liveBusy, practiceFailed, practiceHeld, practiceTick, tracked } from './modules/practice/practice.ts';
import { startDiscord, stopDiscord, syncDiscord } from './discord/bot.ts';
import { gameRunning, watchGames } from './game.ts';

const log = logger('main');
const { drift } = checkHardware();
for (const d of drift) log.warn(`hardware drift: ${d}`);

const db = openDb();
// --no-server: started by dashboard.ts, which already serves the page.
const server = process.argv.includes('--no-server') ? null : startReviewServer(db);
startDiscord(db).catch((e) => log.error('Discord failed to start', { error: String(e) }));
const ac = new AbortController();

const watch = () => { if (!isPaused() && loadSettings().watcher.enabled !== false) watchOnce(db).then(() => watchFootage(db)).then(() => watchYoutube(db)).catch((e) => log.error('watcher failed', { error: String(e) })); };
let lastWatch = Date.now();
watch();
// checks each minute so a pollMinutes change from the dashboard applies without a restart
const timer = setInterval(() => { if (Date.now() - lastWatch >= loadSettings().watcher.pollMinutes * 60_000) { lastWatch = Date.now(); watch(); } }, 60_000);
const track = () => trackOnce(db).then(() => syncDiscord(db)).catch((e) => log.error('tracker failed', { error: String(e) })); // stats tabs follow the new views
const trackTimer = setInterval(track, 60 * 60_000); // hourly: views move slowly, API quotas are small
const learn = () => {
  if (isOff('learn') || !learnDue()) return;
  try {
    const { next, changes, proposal } = learnOnce(db);
    log.info(`learner: ${next.n} clips, label ${next.label}, auc ${JSON.stringify(next.auc)}`);
    bark('Learning', proposal ? `New weights proposed (dashboard, Proposals):\n${changes.join('\n')}\n${proposal.evidence}` : `No weight changes (${next.n} clips, label: ${next.label}).`, { level: 'passive' }).catch(() => {});
  } catch (e) { log.error('learner failed', { error: String(e) }); }
};
learn();
const learnTimer = setInterval(learn, 60 * 60_000); // checks hourly, runs daily
// Weekly top-Shorts study as a queued job: held by the same pause/study switches as campaign studies.
const weekly = () => {
  if (isOff('study') || !weeklyDue()) return;
  if (!db.$client.prepare("select 1 from jobs where type = 'study.weekly' and status in ('queued','running')").get()) enqueue(db, 'study.weekly', {});
};
weekly();
const weeklyTimer = setInterval(weekly, 60 * 60_000); // checks hourly, runs daily
const scout = () => { if (!isPaused() && loadSettings().scout?.enabled !== false) scoutOnce(db).catch((e) => log.error('scout failed', { error: String(e) })); };
const practice = () => practiceTick(db).catch((e) => log.error('practice tick failed', { error: String(e) }));
const practiceTimer = setInterval(practice, 60_000);
const scoutTimer = setInterval(scout, 24 * 60 * 60_000); // daily: joins at most 3 new campaigns per run

const stop = () => { ac.abort(); clearInterval(timer); clearInterval(trackTimer); clearInterval(learnTimer); clearInterval(scoutTimer); clearInterval(weeklyTimer); clearInterval(practiceTimer); server?.close(); stopDiscord(); };
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, stop);
process.on('message', (m) => { if (m === 'stop') stop(); }); // Windows has no SIGTERM for children: dashboard.ts asks over IPC

// One worker process: anything still 'running' at start was cut off by a stop or crash. Requeue before any loop claims.
const orphans = recoverStale(db, 0);
if (orphans) log.warn(`requeued ${orphans} job(s) cut off by the last stop`);
const opts = { signal: ac.signal, paused: isPaused, onFinalFailure: alertFailure };
watchGames(ac.signal);
const playing = () => !!gameRunning(); // heavy GPU/CPU loops wait while the owner plays
// Separate loops: a review push must not wait behind hours of heavy analyze/render jobs.
await Promise.all([
  runWorker(db, { 'vod.analyze': (p) => analyzeVod(db, p), 'clip.render': (p) => renderClip(db, p), 'clip.title': (p) => titleClip(db, p), 'clip.judge': (p) => judgeClip(db, p) }, { ...opts, paused: () => isPaused() || playing() }),
  // Own loop so the Settings switch can hold study jobs queued without blocking clips.
  runWorker(db, { 'campaign.study': (p) => studyJob(p), 'study.weekly': () => weeklyShorts() }, { ...opts, paused: () => (isPaused() && !isPractice()) || isOff('study') || playing() }), // studies are analysis only: also run in practice mode
  // Practice (data/practice): old VODs judged and deleted, never reviewed. Runs while Snip is paused; live work goes first.
  runWorker(db, { 'practice.analyze': tracked((p: any) => analyzeVod(db, p)), 'practice.render': tracked((p: any) => renderClip(db, p)), 'practice.judge': tracked((p: any) => judgeClip(db, p)) },
    { signal: ac.signal, paused: () => practiceHeld() || playing() || (!isPaused() && liveBusy(db)), onFinalFailure: practiceFailed }),
  runWorker(db, { 'review.notify': (p) => notifyReview(db, p) }, opts),
  // Owner's Discover/Join buttons on the dashboard: run even while Snip is paused (one CR tab, one command at a time).
  runWorker(db, { 'campaign.discover': async () => { await discoverAll(); enqueue(db, 'campaign.classify', {}, { maxAttempts: 1 }); }, 'campaign.join': (p) => joinJob(db, p as { id: string }) }, { signal: ac.signal, paused: () => false, onFinalFailure: alertFailure }),
  // Own loop: the first sort of ~200 campaigns takes a while and must not hold the Join button.
  runWorker(db, { 'campaign.classify': () => classifyJob() }, { signal: ac.signal, paused: () => false, onFinalFailure: alertFailure }),
  runWorker(db, { 'clip.publish': (p) => publishClip(db, p), 'post.submit': (p) => askSubmit(db, p), 'post.track': () => trackOnce(db) }, opts),
]);
process.exit(0); // loops end only on stop; Discord and sockets would keep the process alive
