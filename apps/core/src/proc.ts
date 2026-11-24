import { spawn } from 'node:child_process';

/** Runs a program, resolves with stdout. Rejects with the stderr tail so job errors are readable. */
export function runCmd(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-64_000)));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').filter((l) => !/^\s+at /.test(l)).slice(-5).join('\n')}`)),
    );
  });
}
