// Cheap visual analysis of a downloaded Short, no OCR: pacing (scene cuts) and a burned-in caption heuristic.
// Captions in top Shorts are bright text with a dark outline, in one horizontal band, changing with the speech.
import { readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { runCmd } from '../../proc.ts';
import type { Short } from '../../youtube.ts';
import { transcribe } from '../editor/whisper.ts';

const W = 144, H = 256, BANDS = 16, BH = H / BANDS, FPS = 4;
export type Subs = { present: boolean; position: 'top' | 'middle' | 'bottom' | null; y: number | null; wordsPerLine: number | null };
export type ShortLook = { cutsPerSec: number; subs: Subs & { header: boolean } };

/** Per band and frame: share of bright pixels (>=200) next to a dark one (<=60) within 2px, the outline-text signature. */
export function bandScores(gray: Uint8Array): number[][] {
  const frames = Math.floor(gray.length / (W * H)), out: number[][] = [];
  for (let f = 0; f < frames; f++) {
    const o = f * W * H, b = new Array(BANDS).fill(0);
    for (let y = 0; y < H; y++) for (let x = 2; x < W - 2; x++) {
      const i = o + y * W + x;
      if (gray[i] >= 190 && Math.min(gray[i - 1], gray[i - 2], gray[i + 1], gray[i + 2]) <= gray[i] - 110) b[Math.floor(y / BH)]++;
    }
    out.push(b.map((n) => n / (BH * W)));
  }
  return out;
}

/** Per band: share of frames with text, and share of frame pairs where the text amount jumps (a new caption line). */
export function bandStats(scores: number[][]) {
  return scores[0]?.map((_, b) => {
    let on = 0, ch = 0;
    for (let k = 0; k < scores.length; k++) {
      if (scores[k][b] > 0.01) on++;
      if (k && Math.abs(scores[k][b] - scores[k - 1][b]) > 0.005) ch++;
    }
    return { on: on / scores.length, ch: ch / Math.max(scores.length - 1, 1) };
  }) ?? [];
}

/**
 * Captions change with the speech; a title header stays put. Calibrated on 3 study Shorts (2026-11-25):
 * caption bands had change 0.28-0.60, header bands text in >=0.9 of frames with change <0.05, no-caption max change 0.09.
 * Band 0 and 15 skipped: game subtitles and letterbox edges.
 */
export function findSubs(scores: number[][], words: number): Subs & { header: boolean } {
  const st = bandStats(scores);
  const header = st.some((x, b) => b >= 3 && b <= 14 && x.on >= 0.9 && x.ch < 0.08);
  let best = -1;
  for (let b = 1; b < BANDS - 1; b++) if (st[b].on >= 0.25 && st[b].ch >= 0.2 && (best < 0 || st[b].ch > st[best].ch)) best = b;
  if (best < 0) return { present: false, position: null, y: null, wordsPerLine: null, header };
  const changes = Math.round(st[best].ch * (scores.length - 1)), y = (best + 0.5) / BANDS;
  return { present: true, position: y < 0.36 ? 'top' : y < 0.64 ? 'middle' : 'bottom', y: +y.toFixed(2), wordsPerLine: changes && words ? +(words / changes).toFixed(1) : null, header };
}

/** One ffmpeg pass for scene cuts, one for small gray frames. Temp files sit next to the video (ffmpeg filter paths can't hold "E:"). */
export async function lookAt(file: string, durationSec: number, words: number): Promise<ShortLook> {
  const dir = dirname(file), id = basename(file).replace(/\.\w+$/, ''), sc = `${id}.scenes.txt`, raw = join(dir, `${id}.gray`);
  await runCmd('ffmpeg', ['-v', 'error', '-y', '-i', basename(file), '-vf', `select='gt(scene,0.3)',metadata=print:file=${sc}`, '-an', '-f', 'null', '-'], { cwd: dir });
  const cuts = (readFileSync(join(dir, sc), 'utf8').match(/pts_time/g) ?? []).length;
  await runCmd('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `fps=${FPS},scale=${W}:${H},format=gray`, '-an', '-f', 'rawvideo', raw]);
  const subs = findSubs(bandScores(readFileSync(raw)), words);
  rmSync(raw, { force: true }); rmSync(join(dir, sc), { force: true });
  return { cutsPerSec: +(cuts / Math.max(durationSec, 1)).toFixed(2), subs };
}

export type ShortFacts = {
  id: string; title: string; channel: string; url: string; views: number; durationSec: number;
  likeRate: number; commentRate: number; hour: number; weekday: string; tags: string[]; hashtags: string[]; description: string;
  hook: string; wordsPerSec: number; look: ShortLook | null;
};

/** Everything we learn from one Short: API stats + Whisper hook/pace + frames. Whisper failure (no speech) keeps the rest. */
export async function shortFacts(v: Short, file: string, model: string): Promise<ShortFacts> {
  const t = await transcribe({ input: file, model, language: null }).catch(() => ({ words: [] as { w: string; s: number }[] }));
  const dur = v.durationSec || 1, at = new Date(v.publishedAt);
  return {
    id: v.id, title: v.title, channel: v.channel, url: v.url, views: v.views, durationSec: v.durationSec,
    likeRate: v.views ? v.likes / v.views : 0, commentRate: v.views ? v.comments / v.views : 0,
    hour: at.getUTCHours(), weekday: at.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
    tags: v.tags.slice(0, 15), hashtags: [...new Set(v.description.match(/#[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 15), description: v.description.slice(0, 300),
    hook: t.words.filter((w) => w.s < 3).map((w) => w.w).join(' ').trim(), wordsPerSec: +(t.words.length / dur).toFixed(1),
    look: await lookAt(file, dur, t.words.length).catch(() => null),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
/** Markdown lines for the study reports. */
export const factLines = (f: ShortFacts) => [
  `- First 3s: "${f.hook || '(no speech)'}" · ${f.wordsPerSec} words/s · ${f.durationSec}s`,
  `- Likes ${pct(f.likeRate)} · comments ${pct(f.commentRate)} of views · posted ${f.weekday} ${f.hour}:00 UTC`,
  `- Cuts ${f.look?.cutsPerSec ?? '?'}/s · captions ${f.look?.subs.present ? `${f.look.subs.position} (y ${f.look.subs.y}), ~${f.look.subs.wordsPerLine ?? '?'} words/line` : 'none'}${f.look?.subs.header ? ' · title header on screen' : ''}`,
  `- Hashtags: ${f.hashtags.join(' ') || '-'} · tags: ${f.tags.join(', ') || '-'}`,
  `- Description: ${f.description.replace(/\s+/g, ' ') || '-'}`,
].join('\n');
