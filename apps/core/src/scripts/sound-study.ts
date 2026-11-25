// One-off sound study (catch-up proposal 3): does loudness, dead air or music predict views on the study viewer clips?
// Adds lufs, lra, silence (share under -35 dB for 0.5s+), leadSilence (s before the first sound) and musicRatio
// to data/study-eval.json (resumable), then prints the AUC per feature. Label = above this streamer's median views.
// Limit: raw Twitch clips, not our edits (we loudnorm everything), so lufs says little about our final loudness.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../env.ts';
import { auc } from '../modules/learner/weights.ts';
import { runCmd } from '../proc.ts';

const out = join(paths.dataDir, 'study-eval.json');
const cache: Record<string, Record<string, any>> = JSON.parse(readFileSync(out, 'utf8'));
const FEATS = ['lufs', 'lra', 'silence', 'leadSilence', 'musicRatio'] as const;

function parseSound(log: string, dur: number) {
  const num = (re: RegExp) => Number([...log.matchAll(re)].at(-1)?.[1] ?? NaN); // last = the summary, not a running value
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const quiet = starts.reduce((a, s, i) => a + ((ends[i] ?? dur) - s), 0);
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/g), lra: num(/LRA:\s+([\d.]+) LU/g), silence: dur ? quiet / dur : 0, leadSilence: starts[0] === 0 ? (ends[0] ?? dur) : 0 };
}

{
  const rows = Object.values(cache);
  for (const r of rows) {
    if (r.musicRatio !== undefined) continue;
    const file = join(paths.dataDir, 'study', r.streamer, `${r.slug}.mp4`);
    const ff = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-i', file, '-af', 'silencedetect=n=-35dB:d=0.5,ebur128', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const m = JSON.parse(await runCmd(paths.pythonBin, [join(paths.rootDir, 'workers', 'music_detect.py'), JSON.stringify({ input: file })]));
    Object.assign(r, parseSound(ff.stderr.slice(-200_000), r.sec), { musicRatio: m.musicRatio });
    writeFileSync(out, JSON.stringify(cache, null, 1));
  }
  const good = rows.map((r) => { const v = rows.filter((x) => x.streamer === r.streamer).map((x) => x.views).sort((a, b) => a - b); return r.views > v[v.length >> 1]; });
  for (const k of FEATS) {
    const i = rows.map((r, j) => (Number.isFinite(r[k]) ? j : -1)).filter((j) => j >= 0), v = i.map((j) => rows[j][k] as number).sort((a, b) => a - b);
    console.log(`AUC ${k}: ${auc(i.map((j) => rows[j][k]), i.map((j) => good[j]))?.toFixed(2)} (n ${i.length}, median ${v[v.length >> 1]?.toFixed(2)})`);
  }
  // Buckets that map to our knobs: music present, any dead air at the start.
  for (const [name, f] of [['music >= 20%', (r: any) => r.musicRatio >= 0.2], ['lead silence > 1s', (r: any) => r.leadSilence > 1], ['silence > 20%', (r: any) => r.silence > 0.2]] as const) {
    const a = rows.map((r, j) => [f(r), good[j]]), yes = a.filter(([x]) => x), no = a.filter(([x]) => !x);
    const pct = (xs: any[]) => (xs.length ? Math.round((100 * xs.filter(([, g]) => g).length) / xs.length) : 0);
    console.log(`${name}: ${yes.length} clips, ${pct(yes)}% above median vs ${pct(no)}% for the other ${no.length}`);
  }
}
