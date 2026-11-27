// Weekly study: most-viewed gaming/stream Shorts of the past 7 days, any streamer. What titles, pacing and captions win now.
// Feeds the title prompt (example titles) and caption chunking (words per line). Downloads are for analysis only and deleted after.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../env.ts';
import { readHardwareConfig } from '../../hardware.ts';
import { logger } from '../../log.ts';
import { runCmd } from '../../proc.ts';
import { hasYoutubeKey, topShorts } from '../../youtube.ts';
import { factLines, shortFacts, type ShortFacts } from './short-analysis.ts';

const log = logger('weekly');
const DAY = 86_400_000;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const file = () => join(paths.dataDir, 'study', 'weekly.json');

export const weeklyDue = (now = Date.now()) => !existsSync(file()) || now - statSync(file()).mtimeMs > DAY; // daily: owner wants it learning all day

/** One search.list (100 quota units) + one videos.list; ~25 downloads + Whisper, roughly 10-20 min on the GPU. */
export async function weeklyShorts(max = 25) {
  if (!hasYoutubeKey()) return log.info('weekly study skipped: no YOUTUBE_API_KEY');
  const model = readHardwareConfig()?.whisperModelVod ?? 'medium';
  const dir = join(paths.dataDir, 'study', 'weekly');
  mkdirSync(dir, { recursive: true });
  const out: ShortFacts[] = [];
  // relevanceLanguage only ranks; keep Shorts whose uploader set English audio (unset = unknown, skipped).
  const found = await topShorts('twitch stream', new Date(Date.now() - 2 * DAY), 50, { videoCategoryId: '20', relevanceLanguage: 'en', regionCode: 'US' });
  for (const v of found.filter((x) => x.lang.startsWith('en')).slice(0, max)) {
    const mp4 = join(dir, `${v.id}.mp4`);
    try {
      if (!existsSync(mp4)) await runCmd('yt-dlp', ['-q', '--no-warnings', '-f', 'b[height<=1280]/b/bv*+ba', '--merge-output-format', 'mp4', '-o', mp4, v.url], { timeoutMs: 10 * 60_000 });
      out.push(await shortFacts(v, mp4, model));
      log.info(`weekly: ${v.views} views "${v.title}"`);
    } catch (e) { log.warn(`weekly: skipped ${v.id}: ${(e as Error).message.slice(0, 150)}`); }
    finally { for (const f of readdirSync(dir)) if (f.startsWith(v.id)) rmSync(join(dir, f), { force: true }); }
  }
  const caps = out.filter((f) => f.look?.subs.present);
  const sum = [
    `# Top gaming Shorts, week of ${new Date().toISOString().slice(0, 10)} (${out.length} studied)\n`,
    `Median ${median(out.map((f) => f.durationSec)) ?? '?'}s, ${median(out.map((f) => f.wordsPerSec)) ?? '?'} words/s, ${median(out.map((f) => f.look?.cutsPerSec ?? 0)) ?? '?'} cuts/s.`,
    `Captions on ${caps.length}/${out.length}; position ${['top', 'middle', 'bottom'].map((p) => `${p} ${caps.filter((f) => f.look!.subs.position === p).length}`).join(', ')}.`,
    `Title header on screen: ${out.filter((f) => f.look?.subs.header).length}/${out.length}.\n`,
  ].join('\n');
  writeFileSync(join(paths.dataDir, 'study', 'weekly.md'), sum + '\n' + out.map((f) => `### ${f.views.toLocaleString('en-US')} views · ${f.channel} · ${f.title}\n${f.url}\n\n${factLines(f)}\n`).join('\n'));
  writeFileSync(file(), JSON.stringify({ at: new Date().toISOString(), shorts: out }, null, 1));
}

/** What the editor and title writer take from the last weekly study; empty until it has run. */
/** Hashtags that 3+ top Shorts from 2+ channels use, minus any channel or streamer name (no other streamers' tags) and the ones we always add. Max 3. */
export function genericHashtags(shorts: Pick<ShortFacts, 'channel' | 'hashtags'>[], names: string[] = []) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const banned = [...shorts.map((f) => norm(f.channel)), ...names.map(norm)].filter((n) => n.length >= 3);
  const seen = new Map<string, Set<string>>(), uses = new Map<string, number>();
  for (const f of shorts) for (const h of new Set(f.hashtags.map(norm))) { uses.set(h, (uses.get(h) ?? 0) + 1); seen.set(h, (seen.get(h) ?? new Set()).add(f.channel)); }
  return [...uses].filter(([h, n]) => h.length >= 3 && n >= 3 && seen.get(h)!.size >= 2 && !['shorts', 'fyp', 'reels', 'ad'].includes(h) && !banned.some((b) => h.includes(b) || b.includes(h)))
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => `#${h}`);
}

export function weeklyInsights(names: string[] = []): { at: string | null; titles: string[]; wordsPerLine: number | null; hashtags: string[]; titleLen: number | null } {
  try {
    const { at, shorts } = JSON.parse(readFileSync(file(), 'utf8')) as { at: string; shorts: ShortFacts[] };
    const wpl = shorts.map((f) => f.look?.subs.wordsPerLine).filter((x): x is number => !!x);
    // shortcut: wordsPerLine undercounts when captions highlight word by word (each color change counts as a new line); clamp 2-4.
    return { at, titles: [...shorts].sort((a, b) => b.views - a.views).slice(0, 5).map((f) => f.title), wordsPerLine: wpl.length >= 5 ? Math.min(4, Math.max(2, Math.round(median(wpl)))) : null,
      hashtags: genericHashtags(shorts, names), titleLen: shorts.length >= 5 ? Math.min(100, Math.max(30, median(shorts.map((f) => f.title.length)))) : null };
  } catch { return { at: null, titles: [], wordsPerLine: null, hashtags: [], titleLen: null }; }
}
