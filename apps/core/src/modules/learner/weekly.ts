// Daily study per kind (gaming, talk, music): top Shorts of the past 2 days, plus the best and up to 3 weak Shorts of their channels (patterns.ts).
// Gaming tops also: What titles, pacing and captions win now.
// Feeds the title prompt (example titles) and caption chunking (words per line). Downloads are for analysis only and deleted after.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../env.ts';
import { readHardwareConfig } from '../../hardware.ts';
import { logger } from '../../log.ts';
import { runCmd } from '../../proc.ts';
import { loadSettings } from '../../config.ts';
import { channelShorts, hasYoutubeKey, type Short, topShorts } from '../../youtube.ts';
import { stopWhisper } from '../editor/whisper.ts';
import { askJson, useGpu } from '../judge/judge.ts';
import { CATEGORIES, type Kind, LABELS, type Row, saveRows, setNow, studied } from './patterns.ts';
import { factLines, shortFacts, type ShortFacts } from './short-analysis.ts';

const log = logger('weekly');
const DAY = 86_400_000;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const file = () => join(paths.dataDir, 'study', 'weekly.json');

export const weeklyDue = (now = Date.now()) => !existsSync(file()) || now - statSync(file()).mtimeMs > DAY; // daily: owner wants it learning all day

type Picked = { v: Short; kind: Kind; group: Row['group'] };

/** Per kind: one search.list (100 quota units) for the top Shorts, then 2 units per contrast channel. ~100 downloads + Whisper a day, mostly 30-60 min on the GPU. */
export async function weeklyShorts() {
  if (!hasYoutubeKey()) return log.info('weekly study skipped: no YOUTUBE_API_KEY');
  const model = readHardwareConfig()?.whisperModelVod ?? 'medium';
  const dir = join(paths.dataDir, 'study', 'weekly');
  mkdirSync(dir, { recursive: true });
  try {
    for (const kind of Object.keys(CATEGORIES) as Kind[]) {
      const c = CATEGORIES[kind], name = c.label.toLowerCase();
      setNow({ what: `Finding popular ${name} Shorts`, kind, step: 'Searching YouTube', done: 0, total: 0 });
      // relevanceLanguage only ranks; keep Shorts whose uploader set English audio (unset = unknown, skipped).
      const found = await topShorts(c.query, new Date(Date.now() - 2 * DAY), 50, { ...(c.category && { videoCategoryId: c.category }), relevanceLanguage: 'en', regionCode: 'US' });
      const tops = found.filter((x) => x.lang.startsWith('en')).slice(0, c.top);
      const picks: Picked[] = tops.map((v) => ({ v, kind, group: 'top' }));
      const seen = studied(kind), channels = [...new Set(tops.map((v) => v.channelId))].slice(0, 8);
      for (const ch of channels) { // contrast inside one channel: same audience and style, so the difference is the clip itself
        try {
          const own = (await channelShorts(ch)).filter((v) => !seen.has(v.id)); // sorted by views
          if (own.length < 8) continue;
          const q = Math.floor(own.length / 4);
          // up to 3 weak ones from the bottom quarter: 1 a channel took ~4 days to reach NEED flops
          const best = own.slice(0, q).find((v) => !tops.some((t) => t.id === v.id)), weak = own.slice(-q).slice(-3);
          if (best) picks.push({ v: best, kind, group: 'top' });
          for (const v of weak) picks.push({ v, kind, group: 'flop' });
        } catch (e) { log.warn(`weekly: channel list failed: ${(e as Error).message.slice(0, 120)}`); }
      }
      const facts: { p: Picked; f: ShortFacts; laugh: number; cheer: number }[] = [];
      for (const [i, p] of picks.entries()) {
        setNow({ what: `Studying ${name} Shorts`, kind, step: 'Downloading and listening', done: i, total: picks.length });
        const mp4 = join(dir, `${p.v.id}.mp4`);
        try {
          if (!existsSync(mp4)) await runCmd('yt-dlp', ['-q', '--no-warnings', '-f', 'b[height<=1280]/b/bv*+ba', '--merge-output-format', 'mp4', '-o', mp4, p.v.url], { timeoutMs: 10 * 60_000 });
          const f = await shortFacts(p.v, mp4, model);
          let laugh = 0, cheer = 0;
          try {
            const m = JSON.parse(await runCmd(paths.pythonBin, [join(paths.rootDir, 'workers', 'music_detect.py'), JSON.stringify({ input: mp4 })], { timeoutMs: 5 * 60_000 }));
            laugh = m.laughMax ?? 0; cheer = m.cheerMax ?? 0;
          } catch (e) { log.warn(`weekly: sound check skipped ${p.v.id}: ${(e as Error).message.slice(0, 120)}`); }
          facts.push({ p, f, laugh, cheer });
          log.info(`weekly ${kind}/${p.group}: ${p.v.views} views "${p.v.title}"`);
        } catch (e) { log.warn(`weekly: skipped ${p.v.id}: ${(e as Error).message.slice(0, 150)}`); }
        finally { for (const f of readdirSync(dir)) if (f.startsWith(p.v.id)) rmSync(join(dir, f), { force: true }); }
      }
      stopWhisper(); // Whisper and the LLM don't both fit in 12 GB VRAM
      const gpu = await useGpu(loadSettings().judge?.awayMin ?? 10), rows: Row[] = [];
      for (const [i, { p, f, laugh, cheer }] of facts.entries()) {
        setNow({ what: `Learning why ${name} Shorts work`, kind, step: 'Labeling with the local model', done: i, total: facts.length });
        const l = await labelShort(f, kind, gpu).catch((e) => { log.warn(`weekly: label skipped ${f.id}: ${(e as Error).message.slice(0, 120)}`); return null; });
        if (!l) continue;
        // shortcut: a 0.3 YAMNet peak as "audible" is a guess; tune once rows show how the scores spread.
        rows.push({ id: f.id, kind, group: p.group, at: new Date().toISOString(), views: f.views, labels: l.labels, question: l.question,
          hook: f.hook.split(' ').filter(Boolean).length >= 2, laugh: laugh >= 0.3, cheer: cheer >= 0.3, fast: f.wordsPerSec >= 3, laughScore: +laugh.toFixed(3), cheerScore: +cheer.toFixed(3) });
      }
      saveRows(rows);
      if (kind === 'gaming') writeGaming(facts.filter((x) => tops.includes(x.p.v)).map((x) => x.f));
    }
  } finally { setNow(null); }
}

/** The local LLM picks up to 2 reasons from the fixed list; free text would not add up across Shorts. */
async function labelShort(f: ShortFacts, kind: Kind, gpu: boolean): Promise<{ labels: string[]; question: boolean }> {
  const j = await askJson(loadSettings().titles?.model ?? 'gemma4:12b', gpu,
    `A YouTube Short (${CATEGORIES[kind].label.toLowerCase()}). Title: "${f.title}"\nWhat is said: "${f.text || '(no speech)'}"\n\n` +
    `Pick at most 2 reasons from this list that best say why people watch it: ${LABELS.join(', ')}. ` +
    'Also say if someone in it asks the viewer a direct question (not a question to another person in the video).',
    { type: 'object', properties: { labels: { type: 'array', items: { type: 'string', enum: [...LABELS] } }, question: { type: 'boolean' } }, required: ['labels', 'question'] });
  return { labels: [...new Set((j.labels ?? []) as string[])].filter((x) => (LABELS as readonly string[]).includes(x)).slice(0, 2), question: j.question === true };
}

function writeGaming(out: ShortFacts[]) {
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
