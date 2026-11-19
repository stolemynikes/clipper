import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { openDb } from './db/client.ts';
import { jobs } from './db/schema.ts';
import { optionalKeys, paths, requiredKeys } from './env.ts';
import { checkHardware, run } from './hardware.ts';

type Status = 'ok' | 'warn' | 'fail';
const mark: Record<Status, string> = { ok: '\x1b[32m✔\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✖\x1b[0m' };
const results: Status[] = [];

function line(status: Status, label: string, detail = '') {
  results.push(status);
  console.log(`  ${mark[status]} ${label.padEnd(22)} ${detail}`);
}
const section = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m`);
const firstLine = (s: string | null) => s?.split('\n')[0].trim() ?? '';

// --- Hardware
section('Hardware');
const { live, drift } = checkHardware();
line(live.gpu ? 'ok' : 'warn', 'GPU', live.gpu ? `${live.gpu.name}, ${Math.round(live.gpu.vramMiB / 1024)}GB VRAM, driver ${live.gpu.driver}` : 'none');
line('ok', 'CPU / RAM', `${live.cpu.name}, ${live.cpu.cores} cores / ${live.cpu.threads} threads, ${live.ramGB}GB RAM`);
line(live.workDrive.freeGB < 100 ? 'warn' : 'ok', `Disk ${live.workDrive.letter}:`, `${live.workDrive.freeGB}GB free, ${live.workDrive.mediaType}`);
line('ok', 'Derived', `whisper ${live.whisperModelVod} / ${live.whisperModelLive}, ${live.encoder}, ${live.maxParallelRenders} parallel renders`);
for (const w of live.warnings) line('warn', 'Warning', w);
for (const d of drift) line('warn', 'hardware.json', d);

// --- Tools
section('Tools');
const nodeMajorMinor = process.versions.node.split('.').map(Number);
line(nodeMajorMinor[0] > 22 || (nodeMajorMinor[0] === 22 && nodeMajorMinor[1] >= 18) ? 'ok' : 'fail', 'Node.js', `v${process.versions.node} (need 22.18+)`);
const ffmpeg = run('ffmpeg', ['-hide_banner', '-version']);
line(ffmpeg ? 'ok' : 'fail', 'ffmpeg', firstLine(ffmpeg).replace(/ Copyright.*/, '') || 'missing: winget install Gyan.FFmpeg');
line(live.nvenc.includes('h264_nvenc') ? 'ok' : 'warn', 'NVENC', live.nvenc.join(', ') || 'not available, libx264 fallback');
const ytdlp = run('yt-dlp', ['--version']);
line(ytdlp ? 'ok' : 'fail', 'yt-dlp', ytdlp ?? 'missing: winget install yt-dlp.yt-dlp');
const tdExe = join(paths.toolsDir, 'TwitchDownloaderCLI.exe');
const td = run(existsSync(tdExe) ? tdExe : 'TwitchDownloaderCLI', ['--version']);
line(td ? 'ok' : 'fail', 'TwitchDownloaderCLI', td ? firstLine(td).replace(/\+.*/, '') : 'missing: download release from lay295/TwitchDownloader into tools/');
const py = run(paths.pythonBin, ['--version']);
line(py?.includes('3.12') || py?.includes('3.11') ? 'ok' : 'fail', 'Python venv', py ? `${py} (${paths.pythonBin})` : `missing: py -3.12 -m venv .venv`);
const streamlink = run('streamlink', ['--version']);
line(streamlink ? 'ok' : 'warn', 'streamlink', streamlink ?? 'missing (needed in phase 3)');
const ollama = run('ollama', ['--version']);
line(ollama ? 'ok' : 'warn', 'ollama', ollama ? firstLine(ollama) : 'missing (optional, for local titles)');

// --- Python packages
section('Python packages');
const pyCheck = `
import json, importlib.metadata as m
out = {}
for p in ['faster-whisper', 'ctranslate2', 'mediapipe', 'numpy']:
    try: out[p] = m.version(p)
    except Exception: out[p] = None
try:
    import ctranslate2; out['cuda_devices'] = ctranslate2.get_cuda_device_count()
except Exception: out['cuda_devices'] = None
print(json.dumps(out))`;
const pkgs = py ? JSON.parse(run(paths.pythonBin, ['-c', pyCheck]) ?? '{}') : {};
for (const p of ['faster-whisper', 'ctranslate2', 'mediapipe', 'numpy']) {
  line(pkgs[p] ? 'ok' : 'fail', p, pkgs[p] ?? 'missing: .venv\\Scripts\\pip install -r requirements.txt');
}
line(pkgs.cuda_devices > 0 ? 'ok' : 'warn', 'CUDA (ctranslate2)', pkgs.cuda_devices > 0 ? `${pkgs.cuda_devices} device(s)` : 'no CUDA device visible: Whisper will use CPU');

// --- Keys (values never printed)
section('Keys (.env)');
line(existsSync(paths.envFile) ? 'ok' : 'fail', '.env', existsSync(paths.envFile) ? 'found' : 'missing: copy .env.example to .env');
for (const k of requiredKeys) line(process.env[k] ? 'ok' : 'fail', k, process.env[k] ? 'set' : 'not set');
for (const k of optionalKeys) line(process.env[k] ? 'ok' : 'warn', k, process.env[k] ? 'set' : 'not set (optional)');
for (const k of ['HF_HOME', 'PIP_CACHE_DIR', 'TEMP']) {
  const v = process.env[k] ?? '';
  line(v.toUpperCase().startsWith('E:') ? 'ok' : 'warn', k, v ? (v.toUpperCase().startsWith('E:') ? v : `${v} (should be on E:)`) : 'not set (should point to E:)');
}

// --- Database and queue
section('Database');
try {
  const db = openDb();
  const counts = db.select({ status: jobs.status, n: sql<number>`count(*)` }).from(jobs).groupBy(jobs.status).all();
  line('ok', 'SQLite', `${join(paths.dataDir, 'clipping.db')}, migrations applied`);
  line(counts.some((c) => c.status === 'failed') ? 'warn' : 'ok', 'Job queue', counts.map((c) => `${c.n} ${c.status}`).join(', ') || 'empty');
} catch (err) {
  line('fail', 'SQLite', err instanceof Error ? err.message : String(err));
}

// --- Summary
const fails = results.filter((r) => r === 'fail').length;
const warns = results.filter((r) => r === 'warn').length;
console.log(`\n${fails ? mark.fail : mark.ok} ${results.length - fails - warns} ok, ${warns} warning(s), ${fails} failure(s)\n`);
process.exitCode = fails ? 1 : 0;
