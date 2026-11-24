import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { paths } from '../../env.ts';
import type { Word } from './subtitles.ts';

export interface Transcript { language?: string; words: Word[]; peakDb?: number }

// One long-lived `transcribe.py --serve`: loading large-v3 from the HDD takes ~100s, a clip ~6s.
// Stopped after IDLE_MS so the VRAM is free again for gaming.
const IDLE_MS = 5 * 60_000;
let server: { p: ChildProcessWithoutNullStreams; next: () => Promise<IteratorResult<string>>; err: () => string } | null = null;
let chain: Promise<unknown> = Promise.resolve();
let idle: NodeJS.Timeout | undefined;

function start() {
  const p = spawn(paths.pythonBin, [join(paths.rootDir, 'workers', 'transcribe.py'), '--serve'], { windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
  const lines = createInterface({ input: p.stdout })[Symbol.asyncIterator]();
  const s = { p, next: () => lines.next(), err: () => err };
  p.on('exit', () => { if (server === s) server = null; });
  return s;
}

export function stopWhisper(): void {
  clearTimeout(idle);
  server?.p.stdin.end(); // the server exits on stdin EOF
  server = null;
}

/** Requests run one at a time over the same process. */
export function transcribe(req: { input: string; model: string; language: string | null }): Promise<Transcript> {
  const run = chain.then(async () => {
    clearTimeout(idle);
    const s = (server ??= start());
    s.p.stdin.write(JSON.stringify(req) + '\n');
    const { value, done } = await s.next();
    if (done) {
      server = null;
      throw new Error(`transcribe worker exited: ${s.err().trim().split('\n').slice(-3).join(' | ')}`);
    }
    const res = JSON.parse(value) as Transcript & { error?: string };
    if (res.error) throw new Error(`transcribe failed: ${res.error}`);
    return res;
  }).finally(() => { idle = setTimeout(stopWhisper, IDLE_MS); idle.unref(); });
  chain = run.catch(() => {});
  return run;
}
