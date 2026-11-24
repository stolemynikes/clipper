// npm run study: what works for each campaign streamer, before we render whole VODs.
// Most profitable campaign first. Per streamer: most-viewed viewer clips (Twitch Clips API),
// transcribed, so we see what moments, lengths and openings people watch. Report: data/study/<name>.md
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeStreamers } from './config.ts';
import { paths } from './env.ts';
import { readHardwareConfig } from './hardware.ts';
import { runCmd } from './proc.ts';
import { profitScore } from './modules/compliance/campaign-notes.ts';
import { stopWhisper, transcribe } from './modules/editor/whisper.ts';
import { getTopClips, getUserId } from './twitch.ts';
import { hasYoutubeKey, topShorts } from './youtube.ts';

const TOP = Number(process.argv[2] ?? 10);
const DAY = 86_400_000;
const model = readHardwareConfig()?.whisperModelVod ?? 'medium';
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

const list = activeStreamers().filter((s) => s.platform === 'twitch' && s.campaign)
  .sort((a, b) => profitScore(b.campaign!) - profitScore(a.campaign!));
console.log(list.map((s) => `${s.name}: ~$${profitScore(s.campaign!).toFixed(1)} per 1K views`).join('\n'));

try {
  for (const s of list) {
    const from = s.campaign!.rules?.sourceFrom ? new Date(String(s.campaign!.rules.sourceFrom)) : new Date(0);
    const since = new Date(Math.max(from.getTime(), Date.now() - 30 * DAY)); // campaign source window, at most 30 days back
    const clips = (await getTopClips(await getUserId(s.channel), since, TOP)).slice(0, TOP);
    const dir = join(paths.dataDir, 'study', s.name);
    mkdirSync(dir, { recursive: true });
    const rows: string[] = [];
    const stats: { dur: number; wps: number }[] = [];
    for (const c of clips) {
      const file = join(dir, `${c.id}.mp4`);
      if (!existsSync(file)) await runCmd('yt-dlp', ['-q', '--no-warnings', '-f', 'b[height<=720]/b', '-o', file, c.url ?? `https://clips.twitch.tv/${c.id}`]);
      const t = await transcribe({ input: file, model, language: null });
      const text = t.words.map((w) => w.w).join(' ').replace(/\s+/g, ' ').trim();
      const hook = t.words.filter((w) => w.s < 3).map((w) => w.w).join(' ').trim();
      const wps = t.words.length / Math.max(c.duration, 1);
      stats.push({ dur: c.duration, wps });
      rows.push(`### ${c.view_count.toLocaleString('en-US')} views · ${c.duration.toFixed(0)}s · ${c.title ?? ''}\n` +
        `${c.url ?? ''}\n\n- First 3s: "${hook || '(no speech)'}"\n- Words per second: ${wps.toFixed(1)}\n- Text: ${text.slice(0, 600)}\n`);
      console.log(`${s.name}: ${c.view_count} views ${c.duration}s "${c.title}"`);
    }
    const head = `# ${s.name}: top ${clips.length} viewer clips since ${since.toISOString().slice(0, 10)}\n\n` +
      `Campaign: ~$${profitScore(s.campaign!).toFixed(1)} per 1K views (rough).\n` +
      `Median length ${median(stats.map((x) => x.dur)).toFixed(0)}s, median ${median(stats.map((x) => x.wps)).toFixed(1)} words/s, ` +
      `median views ${median(clips.map((c) => c.view_count)).toLocaleString('en-US')}.\n\n`;
    let shorts = '\n## Shorts by other clippers\n\nSkipped: no YOUTUBE_API_KEY in .env.\n';
    if (hasYoutubeKey()) {
      const out: string[] = [];
      // Bare names ("silky") match unrelated Shorts; keep titles that name the streamer and add stream context to the query.
      const name = new RegExp(`\\b${s.name}\\b`, 'i');
      for (const v of (await topShorts(`${s.name} twitch`, since, TOP)).filter((x) => name.test(x.title))) {
        const file = join(dir, `yt-${v.id}.mp4`), sheet = join(dir, `yt-${v.id}.jpg`);
        try {
        if (!existsSync(file)) await runCmd('yt-dlp', ['-q', '--no-warnings', '-f', 'b[height<=1280]/b/bv*+ba', '-o', file, v.url]);
        // 4 frames side by side (one per 6s): shows cam size, caption style, hook text, layout
        if (!existsSync(sheet)) await runCmd('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf',
          "select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,6)',scale=270:-2,tile=4x1", '-frames:v', '1', sheet]);
        const t = await transcribe({ input: file, model, language: null });
        const hook = t.words.filter((w) => w.s < 3).map((w) => w.w).join(' ').trim();
        out.push(`### ${v.views.toLocaleString('en-US')} views · ${v.channel} · ${v.title}\n${v.url}\n\n- First 3s: "${hook || '(no speech)'}"\n- Frames: ${sheet}\n`);
        console.log(`${s.name}: short ${v.views} views "${v.title}"`);
        } catch (e) {
          out.push(`### ${v.views.toLocaleString('en-US')} views · ${v.channel} · ${v.title}\n${v.url}\n\n- Skipped: ${(e as Error).message.slice(0, 200)}\n`);
        }
      }
      shorts = '\n## Shorts by other clippers (YouTube, most viewed)\n\n' + out.join('\n');
    }
    writeFileSync(join(paths.dataDir, 'study', `${s.name}.md`), head + rows.join('\n') + shorts);
  }
} finally {
  stopWhisper();
}
