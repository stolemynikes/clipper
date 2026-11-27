import { spawn } from 'node:child_process';

/** Runs a program, resolves with stdout. Rejects with the stderr tail so job errors are readable.
 *  timeoutMs kills the whole process tree (yt-dlp runs ffmpeg as a child) and rejects, so a stalled download can't hold a job forever. */
export function runCmd(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    let timedOut = false;
    const kill = () => {
      if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/T', '/F', '/PID', String(p.pid)], { windowsHide: true });
      else p.kill('SIGKILL');
    };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : undefined;
    opts.signal?.addEventListener('abort', kill, { once: true });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-64_000)));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${cmd} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`));
      code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').filter((l) => !/^\s+at /.test(l)).slice(-5).join('\n')}`));
    });
  });
}
