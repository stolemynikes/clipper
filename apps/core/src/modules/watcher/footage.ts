// Footage campaigns: the brand gives its own videos (a Drive or Dropbox folder) instead of a Twitch channel.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clipStreamers, type StreamerConfig } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { sources } from '../../db/schema.ts';
import { paths } from '../../env.ts';
import { logger } from '../../log.ts';
import { runCmd } from '../../proc.ts';
import { enqueue } from '../../queue/queue.ts';
import { ensureStreamer } from './watcher.ts';

const log = logger('footage');
const VIDEO = /\.(mp4|mov|mkv|webm|m4v)$/i;
// Windows' own bsdtar reads zip; a GNU tar earlier on PATH (Git Bash) does not. shortcut: Linux VPS needs unzip here.
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const PER_PASS = 3; // new videos per campaign per watch pass: a 50-file folder must not flood the queue

/** Every footage folder link in a brief: Google Drive (folder or file) or Dropbox. Briefs often mix an overlays folder
 *  with the real footage, so all are kept; only videos count. Others (frame.io, Mega, WeTransfer) are not supported yet. */
export function footageLinks(text: string): string[] {
  return [...new Set(text.match(/https:\/\/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders|file\/d)\/[\w-]{10,}|https:\/\/(?:www\.)?dropbox\.com\/(?:scl\/f[io]|s|sh)\/[^\s"'<>)\]]+/gi) ?? [])];
}

/** Dropbox share link as a direct download (a folder comes as one zip). */
export const dropboxDirect = (url: string) => { const u = new URL(url); u.searchParams.set('dl', '1'); return u.toString(); };

/** Downloads each folder once into data/footage/<name>/<n>/ (marker .done). Returns the video files, also in subfolders. */
export async function fetchFootage(name: string, urls: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const [i, url] of urls.entries()) files.push(...await fetchOne(join(paths.dataDir, 'footage', name, String(i)), url));
  return files;
}

async function fetchOne(dir: string, url: string): Promise<string[]> {
  const done = join(dir, '.done');
  if (!existsSync(done) || readFileSync(done, 'utf8') !== url) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const timeoutMs = 2 * 3600_000;
    // shortcut: no size check before downloading; add one if a campaign shares hundreds of GB.
    if (url.includes('drive.google.com')) {
      const folder = url.includes('/folders/');
      // One file Drive refuses (quota, removed) must not lose the rest: keep what came, only videos count.
      await runCmd(paths.pythonBin, ['-m', 'gdown', ...(folder ? ['--folder'] : ['--fuzzy']), '--quiet', url, '-O', folder ? dir : dir + '/'], { timeoutMs })
        .catch((err) => log.warn('footage download incomplete', { error: String(err).split('\n').slice(0, 2).join(' ').slice(0, 200) }));
    } else {
      const zip = join(dir, 'footage.download');
      await runCmd('curl', ['-sSL', '--fail', '--max-filesize', String(50 * 2 ** 30), '-o', zip, dropboxDirect(url)], { timeoutMs });
      // Folder links give a zip; a file link gives the video itself. Windows tar reads zip.
      const head = Buffer.alloc(2), fd = openSync(zip, 'r'); readSync(fd, head, 0, 2, 0); closeSync(fd);
      if (head.toString() === 'PK') { await runCmd(TAR, ['-xf', zip, '-C', dir]); rmSync(zip); }
      else renameSync(zip, join(dir, 'footage.mp4'));
    }
    writeFileSync(done, url);
  }
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : VIDEO.test(e.name) ? [join(d, e.name)] : []);
  return walk(dir).filter((f) => statSync(f).size > 0).sort();
}

const probe = async (file: string) => Number(await runCmd('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])) || 0;

/** One pass over the active footage campaigns: download the folder, queue up to PER_PASS new videos. */
export async function watchFootage(db: Db) {
  for (const cfg of clipStreamers().filter((s) => s.platform === 'footage' && s.footage?.length)) {
    try { await watchOne(db, cfg); } catch (err) { log.error(`footage ${cfg.name} failed`, { error: String(err).slice(0, 300) }); }
  }
}

async function watchOne(db: Db, cfg: StreamerConfig) {
  const streamerId = ensureStreamer(db, cfg, cfg.name).id;
  let added = 0;
  for (const file of await fetchFootage(cfg.name, cfg.footage!)) {
    if (added >= PER_PASS) break;
    const row = db.insert(sources).values({ url: file, streamerId, durationSec: Math.round(await probe(file)) }).onConflictDoNothing().returning().get();
    if (!row) continue;
    enqueue(db, 'vod.analyze', { sourceId: row.id, vodId: '' });
    added++;
  }
  if (added) log.info(`${cfg.name}: queued ${added} footage videos`);
}

/** Loudness (RMS dB) per window of a local file, via ffmpeg astats: one value per windowSec, no PCM in memory. */
export async function loudness(file: string, windowSec: number): Promise<number[]> {
  const out = await runCmd('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-af',
    `asetnsamples=n=${8000 * windowSec}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`, '-f', 'null', '-'], { timeoutMs: 30 * 60_000 });
  return [...out.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => m[1] === '-inf' ? -100 : Number(m[1]));
}
