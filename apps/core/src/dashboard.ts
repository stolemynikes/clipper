// Always-on entry: serves the dashboard and starts the heavy parts (worker + Ollama) only while a dashboard
// switch asks for work. Everything off: the worker finishes its current step, then it and Ollama stop.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { paths } from './env.ts';
import { logger } from './log.ts';
import { isPractice } from './modules/practice/practice.ts';
import { isPaused } from './review/review.ts';
import { startReviewServer } from './review/server.ts';

const log = logger('dashboard');
const db = openDb();
const server = startReviewServer(db);
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
let worker: ChildProcess | null = null, ollama: ChildProcess | null = null, stopping = false;

// Discover/Join buttons work while Snip is off: their queued job wakes the worker until it is done.
const buttonJobs = db.$client.prepare("select 1 from jobs where type in ('campaign.discover','campaign.join') and status in ('queued','running') limit 1");
export const wanted = () => !isPaused() || isPractice() || Boolean(buttonJobs.get());

const up = () => fetch(OLLAMA, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const killTree = (p: ChildProcess) => p.pid && spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });

async function tick() {
  const want = wanted();
  if (want && !worker) {
    if (!ollama && !(await up())) {
      ollama = spawn('ollama', ['serve'], { stdio: 'ignore', windowsHide: true });
      ollama.on('exit', () => { ollama = null; });
      ollama.on('error', (e) => { log.warn('ollama did not start', { error: String(e) }); ollama = null; });
    }
    const out = openSync(join(paths.dataDir, 'worker.log'), 'a');
    worker = spawn(process.execPath, ['src/main.ts', '--no-server'], { cwd: join(import.meta.dirname, '..'), stdio: ['ignore', out, out, 'ipc'], windowsHide: true });
    stopping = false;
    log.info('work switched on: worker and Ollama started');
    worker.on('exit', (code) => {
      worker = null;
      if (ollama) { killTree(ollama); ollama = null; }
      log.info(`worker stopped (code ${code}), Ollama stopped`);
    });
  } else if (!want && worker && !stopping) {
    stopping = true;
    worker.send('stop'); // finishes the current step first; Ollama stops when the worker exits
    log.info('work switched off: worker stops after the current step');
  }
}
const timer = setInterval(() => tick().catch((e) => log.error('dashboard tick failed', { error: String(e) })), 5000);
tick().catch(() => {});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { clearInterval(timer); server.close(); if (worker) killTree(worker); if (ollama) killTree(ollama); process.exit(0); });
