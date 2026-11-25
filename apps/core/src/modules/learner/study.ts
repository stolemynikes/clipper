// Study: what works for a streamer, before we render whole VODs. Most-viewed viewer clips (Twitch Clips API)
// and most-viewed Shorts by other clippers (YouTube Data API), transcribed. Report: data/study/<name>.md.
// Downloads are for analysis only: never reposted (hard rule: no reuploads).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeStreamers, type StreamerConfig } from '../../config.ts';
import { paths } from '../../env.ts';
import { readHardwareConfig } from '../../hardware.ts';
import { logger } from '../../log.ts';
import { runCmd } from '../../proc.ts';
import { profitScore, viewsToPay } from '../compliance/campaign-notes.ts';
import { transcribe } from '../editor/whisper.ts';
import { getTopClips, getUserId } from '../../twitch.ts';
import { hasYoutubeKey, topShorts } from '../../youtube.ts';
import { factLines, shortFacts } from './short-analysis.ts';

const log = logger('study');
const DAY = 86_400_000;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
export type StudyTarget = { name: string; channel: string; campaign?: StreamerConfig['campaign'] };
export type Progress = { done: number; total: number; finished?: string; medianClipViews?: number; medianShortViews?: number; error?: string };

const dirOf = () => join(paths.dataDir, 'study');
export const progressFile = (name: string) => join(dirOf(), `${name}.progress.json`);
export function readProgress(name: string): Progress | null {
  try { return JSON.parse(readFileSync(progressFile(name), 'utf8')); } catch { return null; }
}

export const pay = (s: StudyTarget) => (s.campaign ? `first $10 at ~${viewsToPay(s.campaign).toLocaleString('en-US')} views, ~$${profitScore(s.campaign).toFixed(1)} per 1K (rough)` : 'no campaign, study only');

export async function studyStreamer(s: StudyTarget, top: number, onProgress: (p: Progress) => void = () => {}): Promise<Progress> {
  const model = readHardwareConfig()?.whisperModelVod ?? 'medium';
  const from = s.campaign?.rules?.sourceFrom ? new Date(String(s.campaign.rules.sourceFrom)) : new Date(0);
  const since = new Date(Math.max(from.getTime(), Date.now() - 30 * DAY)); // campaign source window, at most 30 days back
  const clips = (await getTopClips(await getUserId(s.channel), since, top)).slice(0, top);
  // Bare names ("silky") match unrelated Shorts; keep titles that name the streamer and add stream context to the query.
  const name = new RegExp(`\\b${s.name}\\b`, 'i');
  const shortsList = hasYoutubeKey() ? (await topShorts(`${s.name} twitch`, since, top)).filter((x) => name.test(x.title)) : [];
  const p: Progress = { done: 0, total: clips.length + shortsList.length };
  onProgress(p);
  const dir = join(dirOf(), s.name);
  mkdirSync(dir, { recursive: true });
  const rows: string[] = [];
  const stats: { dur: number; wps: number }[] = [];
  for (const c of clips) {
    const file = join(dir, `${c.id}.mp4`);
    if (!existsSync(file)) await runCmd('yt-dlp', ['-q', '--no-warnings', '-f', 'b[height<=720]/b', '-o', file, c.url ?? `https://clips.twitch.tv/${c.id}`]);
    // One bad clip (e.g. no audio) must not stop the whole study.
    const t = await transcribe({ input: file, model, language: null }).catch(() => ({ words: [] as { w: string; s: number }[] }));
    const text = t.words.map((w) => w.w).join(' ').replace(/\s+/g, ' ').trim();
    const hook = t.words.filter((w) => w.s < 3).map((w) => w.w).join(' ').trim();
    const wps = t.words.length / Math.max(c.duration, 1);
    stats.push({ dur: c.duration, wps });
    rows.push(`### ${c.view_count.toLocaleString('en-US')} views · ${c.duration.toFixed(0)}s · ${c.title ?? ''}\n` +
      `${c.url ?? ''}\n\n- First 3s: "${hook || '(no speech)'}"\n- Words per second: ${wps.toFixed(1)}\n- Text: ${text.slice(0, 600)}\n`);
    log.info(`${s.name}: ${c.view_count} views ${c.duration}s "${c.title}"`);
    p.done++; onProgress(p);
  }
  const head = `# ${s.name}: top ${clips.length} viewer clips since ${since.toISOString().slice(0, 10)}\n\n` +
    `Campaign: ${pay(s)}.\n` +
    `Median length ${median(stats.map((x) => x.dur)).toFixed(0)}s, median ${median(stats.map((x) => x.wps)).toFixed(1)} words/s, ` +
    `median views ${median(clips.map((c) => c.view_count)).toLocaleString('en-US')}.\n\n`;
  let shorts = '\n## Shorts by other clippers\n\nSkipped: no YOUTUBE_API_KEY in .env.\n';
  if (hasYoutubeKey()) {
    const out: string[] = [];
    for (const v of shortsList) {
      const file = join(dir, `yt-${v.id}.mp4`), sheet = join(dir, `yt-${v.id}.jpg`);
      try {
        if (!existsSync(file)) await runCmd('yt-dlp', ['-q', '--no-warnings', '-f', 'b[height<=1280]/b/bv*+ba', '--merge-output-format', 'mp4', '-o', file, v.url]);
        // 4 frames side by side (one per 6s): shows cam size, caption style, hook text, layout
        if (!existsSync(sheet)) await runCmd('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf',
          "select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,6)',scale=270:-2,tile=4x1", '-frames:v', '1', sheet]);
        out.push(`### ${v.views.toLocaleString('en-US')} views · ${v.channel} · ${v.title}\n${v.url}\n\n${factLines(await shortFacts(v, file, model))}\n- Frames: ${sheet}\n`);
        log.info(`${s.name}: short ${v.views} views "${v.title}"`);
      } catch (e) {
        out.push(`### ${v.views.toLocaleString('en-US')} views · ${v.channel} · ${v.title}\n${v.url}\n\n- Skipped: ${(e as Error).message.slice(0, 200)}\n`);
      }
      p.done++; onProgress(p);
    }
    shorts = '\n## Shorts by other clippers (YouTube, most viewed)\n\n' + out.join('\n');
  }
  writeFileSync(join(dirOf(), `${s.name}.md`), head + rows.join('\n') + shorts);
  return { ...p, finished: new Date().toISOString(), medianClipViews: median(clips.map((c) => c.view_count)), medianShortViews: median(shortsList.map((v) => v.views)) };
}

/** Queue job: study one campaign streamer, progress in data/study/<name>.progress.json for the campaigns page. */
export async function studyJob({ name }: { name: string }) {
  const s = activeStreamers().find((x) => x.name === name);
  if (!s) return log.info(`study ${name}: no running campaign, skipped`);
  mkdirSync(dirOf(), { recursive: true });
  const save = (p: Progress) => writeFileSync(progressFile(name), JSON.stringify(p));
  try {
    save(await studyStreamer(s, 10, save));
  } catch (e) {
    save({ ...(readProgress(name) ?? { done: 0, total: 0 }), error: (e as Error).message.slice(0, 200) });
    throw e;
  }
}
