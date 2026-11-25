// "Is it fun to watch?" signals per rendered clip, on top of chat and viewer clips (loud != funny):
// laughMax/cheerMax (YAMNet peak score, from music_detect; the share-of-frames ratio was ~always 0 under speech), speech (local LLM reads the transcript),
// visual (same LLM looks at 4 frames). They only change the score once the learner has proven them (weights start at 0).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadSettings } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { clips, moments } from '../../db/schema.ts';
import { paths } from '../../env.ts';
import { logger } from '../../log.ts';
import { runCmd } from '../../proc.ts';
import { enqueue } from '../../queue/queue.ts';
import { stopWhisper } from '../editor/whisper.ts';
import { learnedWeights } from '../learner/weights.ts';
import { tweaks } from '../practice/proposals.ts';
import { sourceContext } from '../vod-clipper/analyze.ts';
import { type Proposal, proposalDir, proposals, recordPair } from '../practice/proposals.ts';
import { LAYOUT_PREFIX, layoutPrompt, layoutResult, layoutRules, type Rule } from './layout.ts';

const log = logger('judge');
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
export const FUN_SIGNALS = ['laughMax', 'cheerMax', 'speech', 'visual'] as const;
export type FunSignals = Partial<Record<(typeof FUN_SIGNALS)[number], number>>;

/** Score bonus from the fun signals (0-1 each) with the learned weights. */
export const funBonus = (s: FunSignals, w: Record<string, number>) => FUN_SIGNALS.reduce((a, k) => a + (w[k] ?? 0) * (s[k] ?? 0), 0);

/** Owner away from the PC (no mouse/keyboard for awayMin) -> GPU; otherwise CPU so games and work keep the GPU. */
export async function useGpu(awayMin: number): Promise<boolean> {
  try {
    const idleSec = Number(await runCmd('powershell', ['-NoProfile', '-Command',
      'Add-Type \'using System;using System.Runtime.InteropServices;public struct L{public uint s;public uint t;}public class I{[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref L l);}\';' +
      '$l=New-Object L;$l.s=8;[void][I]::GetLastInputInfo([ref]$l);[int](([Environment]::TickCount-[int64]$l.t)/1000)']));
    return idleSec >= awayMin * 60;
  } catch {
    return false; // unknown: stay off the GPU
  }
}

async function askJson(model: string, gpu: boolean, prompt: string, format: object, images?: string[]) {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model, stream: false, think: false,
      keep_alive: gpu ? '2m' : 0, // CPU: free the ~8 GB RAM right away
      options: { temperature: 0, num_gpu: gpu ? 999 : 0 },
      format,
      messages: [{ role: 'user', content: prompt, ...(images && { images }) }],
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${model}: HTTP ${r.status}`);
  return JSON.parse(((await r.json()) as { message?: { content?: string } }).message?.content ?? '{}');
}

export async function ask(model: string, gpu: boolean, prompt: string, images?: string[]): Promise<{ score: number; why: string }> {
  const j = await askJson(model, gpu, prompt, { type: 'object', properties: { score: { type: 'integer' }, why: { type: 'string' } }, required: ['score', 'why'] }, images);
  return { score: Math.max(0, Math.min(10, Number(j.score) || 0)), why: String(j.why ?? '').slice(0, 160) };
}

const BROKEN = { type: 'object', required: ['broken'], properties: { broken: { type: 'array', items: { type: 'object', required: ['id', 'why'], properties: { id: { type: 'string' }, why: { type: 'string' } } } } } };
export async function askLayout(model: string, gpu: boolean, rules: Rule[], images: string[]) {
  const j = await askJson(model, gpu, layoutPrompt(rules), BROKEN, images);
  return layoutResult((Array.isArray(j.broken) ? j.broken : []).map((b: { id?: unknown; why?: unknown }) => ({ id: String(b.id ?? ''), why: String(b.why ?? '').slice(0, 160) })), rules);
}

/** Transcripts of this streamer's most-viewed viewer clips (from the study report): what people liked before. */
export function studyExamples(name: string, n = 3): string[] {
  const file = join(paths.dataDir, 'study', `${name}.md`);
  if (!existsSync(file)) return [];
  return [...readFileSync(file, 'utf8').matchAll(/^- Text: (.+)$/gm)].slice(0, n).map((m) => m[1].slice(0, 300));
}

export const speechPrompt = (transcript: string, examples: string[]) =>
  `Rate how fun this short stream clip is to watch, from its transcript alone. Funny, dramatic, surprising, a strong reaction or a story with a payoff scores high.
Loud or busy is not enough. Boring talk, reading a menu, or nothing happening scores low.
${examples.length ? `Clips of this streamer that many viewers liked:\n${examples.map((e) => `- "${e}"`).join('\n')}\n` : ''}
Transcript:
"""${transcript.slice(0, 1500)}"""
Return JSON: "score" 0-10, "why" one short sentence.`;

export const VISUAL_PROMPT = `These are 4 frames from a short stream clip, in order. Rate 0-10 how much is visibly happening that makes people keep watching:
a strong facial reaction, action in the game, something surprising on screen. A static menu, a website, or a calm face scores low.
Ignore captions, chat boxes and title text drawn on top: an editor added those, they are not what happens.
Return JSON: "score" 0-10, "why" one short sentence.`;

export async function frames(file: string, dur: number, width = 360, at = [0.2, 0.4, 0.6, 0.8].map((f) => dur * f)): Promise<string[]> { // layout check: 540+, thin strips vanish at 360
  const out: string[] = [];
  for (const t of at) {
    const jpg = await runCmd('powershell', ['-NoProfile', '-Command', // binary stdout via base64: runCmd returns text
      `$p=[IO.Path]::GetTempFileName()+'.jpg'; ffmpeg -v error -y -ss ${t.toFixed(1)} -i '${file.replace(/'/g, "''")}' -frames:v 1 -vf scale=${width}:-2 $p; [Convert]::ToBase64String([IO.File]::ReadAllBytes($p)); Remove-Item $p`]);
    out.push(jpg.trim());
  }
  return out;
}

export const PAIR_PROMPT = `Two edits of a short stream clip for TikTok/Shorts. Images 1-4 are edit 1, images 5-8 are edit 2, each in time order.
They may differ only in the captions (size, words per line, position, style), or not at all.
Which edit is easier to read on a phone and more fun to watch? Look at the captions and whether they hide faces or action.
If you see no real difference, answer 0. Do not guess.
Return JSON: "pick" 1, 2 or 0, "why" one short sentence.`;
const PICK = { type: 'object', properties: { pick: { type: 'integer' }, why: { type: 'string' } }, required: ['pick', 'why'] };

/** Practice A/B: pairwise judge on clip.mp4 (current) vs clip-<id>.mp4 per proposal, random order; ~1 in 5 is an A/A control. */
/** Mid-points of 4 caption events spread over the clip (from the burned-in .ass). */
export function captionTimes(ass: string): number[] {
  if (!existsSync(ass)) return [];
  const sec = (t: string) => { const [h, m, x] = t.split(':').map(Number); return h * 3600 + m * 60 + x; };
  const mids = [...readFileSync(ass, 'utf8').matchAll(/^Dialogue: \d+,([\d:.]+),([\d:.]+),Caption,/gm)].map((m) => (sec(m[1]) + sec(m[2])) / 2);
  return mids.length <= 4 ? mids : [0.15, 0.4, 0.65, 0.9].map((f) => mids[Math.floor(f * (mids.length - 1))]);
}

export const LENGTH_PROMPT = `Two cuts of the same stream moment for TikTok/Shorts: transcripts with their length.
They differ only in where the cut starts and ends, or not at all.
Which cut works better as a Short? A good cut gets to the point fast, keeps the build-up needed to get the joke,
and ends right after the payoff. If you see no real difference, answer 0. Do not guess.
Return JSON: "pick" 1, 2 or 0, "why" one short sentence.`;
type Cut = { sec: number; text: string };
const cutText = (c: Cut, n: number) => `Cut ${n} (${c.sec.toFixed(0)}s): "${c.text.slice(0, 1500)}"`;

async function judgePair(model: string, gpu: boolean, clipId: number, dir: string, dur: number, text: string) {
  const idFile = join(dir, 'proposals.txt'), a = join(dir, 'clip.mp4');
  if (!existsSync(idFile)) return;
  // Frames where a caption is on screen: a frame without one looks the same in both edits and invites a guess.
  const at = captionTimes(join(dir, 'clip.ass'));
  let fa: string[] | null = null;
  const out: string[] = [];
  for (const id of readFileSync(idFile, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean)) {
    const p = proposals().find((x) => x.id === id);
    if (!p || p.status !== 'testing') continue;
    try {
      const cut = join(dir, `clip-${id}.json`), b = join(dir, `clip-${id}.mp4`);
      if (existsSync(cut)) { // length proposal: other start/end, judged on the transcripts (stills cannot show length)
        const cb = JSON.parse(readFileSync(cut, 'utf8')) as Cut, ca = { sec: dur, text };
        if (cb.text === ca.text) { out.push(`${id} same cut`); continue; } // proposal changes nothing here: no evidence either way
        out.push(await judgeOne(clipId, p, ca, cb, (x, y) => askJson(model, gpu, `${LENGTH_PROMPT}\n\n${cutText(x, 1)}\n\n${cutText(y, 2)}`, PICK)));
      } else if (existsSync(b)) {
        if (at.length < 2) { out.push(`${id} no captions`); continue; }
        fa ??= await frames(a, dur, 540, at);
        const fb = await frames(b, dur, 540, at);
        out.push(await judgeOne(clipId, p, fa, fb, (x, y) => askJson(model, gpu, PAIR_PROMPT, PICK, [...x, ...y]), [fa[1], fb[1]]));
      }
    } catch (e) { out.push(`${id} failed`); log.warn(`clip ${clipId}: pair ${id} failed: ${(e as Error).message}`); }
  }
  return out.join(', ');
}

/** One A/B (or, 1 in 5, an A/A control) for proposal p: `run` asks the judge about (first, second). */
async function judgeOne<T>(clipId: number, p: Proposal, a: T, b: T, run: (x: T, y: T) => Promise<{ pick?: unknown; why?: unknown }>, jpg?: [string, string]) {
  const id = p.id;
  if (Math.random() < 0.2) { // A/A: same edit twice; the right answer is 0, a 1/2 lean shows position bias
    const j = await run(a, a);
    const pick = ([0, 1, 2].includes(Number(j.pick)) ? Number(j.pick) : 0) as 0 | 1 | 2;
    recordPair(id, { aa: pick });
    return `${id} A/A ${pick}`;
  }
  const newFirst = Math.random() < 0.5;
  const j = await run(newFirst ? b : a, newFirst ? a : b);
  const n = Number(j.pick), pick = n === 0 || ![1, 2].includes(n) ? 'same' : (n === 1) === newFirst ? 'new' : 'old';
  const keep = !!jpg && p.frames.length < 6; // a few old/new frames for the report page
  if (keep) {
    mkdirSync(proposalDir(id), { recursive: true });
    writeFileSync(join(proposalDir(id), `${clipId}-old.jpg`), Buffer.from(jpg[0], 'base64'));
    writeFileSync(join(proposalDir(id), `${clipId}-new.jpg`), Buffer.from(jpg[1], 'base64'));
  }
  recordPair(id, { pair: { clipId, newFirst, pick, why: String(j.why ?? '').slice(0, 160), at: Date.now() }, ...(keep && { frames: { clipId, old: `${clipId}-old.jpg`, new: `${clipId}-new.jpg` } }) });
  return `${id} ${pick}`;
}

/** Calibration sheet: one frame + transcript + gemma's scores per practice clip, so Claude can score a sample and compare. */
function saveCalibration(clipId: number, frame: string | undefined, transcript: string | null, fun: object) {
  const d = join(paths.dataDir, 'practice-frames');
  mkdirSync(d, { recursive: true });
  if (frame) writeFileSync(join(d, `${clipId}.jpg`), Buffer.from(frame, 'base64'));
  appendFileSync(join(d, 'index.jsonl'), JSON.stringify({ clipId, transcript: (transcript ?? '').slice(0, 1500), ...fun }) + '\n');
}

/** Weights frozen at the last learner run before proposals, plus owner-approved weight proposals. */
const liveWeights = () => ({ ...learnedWeights(), ...tweaks().funWeights });

/** Bump when a prompt or judge model changes, so the learner can tell judgments apart. */
export const JUDGE_VERSION = 1;

/** Job: judge one clip, store the signals on its moment, add the proven part to the score, then ask for review. */
export async function judgeClip(db: Db, { clipId, notify = true }: { clipId: number; notify?: boolean }) {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) return;
  const moment = db.select().from(moments).where(eq(moments.id, clip.momentId)).get()!;
  const { cfg } = sourceContext(db, moment.sourceId);
  const s = loadSettings();
  const model = s.titles?.model ?? 'gemma4:12b';
  const music = (clip.compliance as { music?: FunSignals } | null)?.music;
  const fun: FunSignals & { judgeWhy?: string; judgeGpu?: number; layoutPenalty?: number; judgeVersion?: number } = // judgeWhy: text in the numeric signals JSON, for the review page
{ laughMax: music?.laughMax, cheerMax: music?.cheerMax };
  let layoutWarnings: string[] | undefined;
  try {
    const gpu = await useGpu(s.judge?.awayMin ?? 10);
    if (gpu) stopWhisper(); // Whisper and the LLM don't both fit in 12 GB VRAM
    const t0 = Date.now();
    const why: string[] = [];
    if (clip.transcript && clip.transcript.split(' ').length >= 8) {
      const a = await ask(model, gpu, speechPrompt(clip.transcript, studyExamples(cfg.name)));
      fun.speech = a.score / 10; why.push(`talk ${a.score}: ${a.why}`);
    }
    let shot: string | undefined;
    if (existsSync(clip.filePath)) {
      const vis = await frames(clip.filePath, clip.durationSec ?? 20); shot = vis[1];
      const b = await ask(model, gpu, VISUAL_PROMPT, vis);
      fun.visual = b.score / 10; why.push(`screen ${b.score}: ${b.why}`);
      const l = await askLayout(model, gpu, layoutRules(cfg.campaign), await frames(clip.filePath, clip.durationSec ?? 20, 540));
      fun.layoutPenalty = l.penalty; layoutWarnings = l.warnings;
      if (l.warnings.length) why.push(`layout -${l.penalty}: ${l.warnings.join('; ')}`);
    }
    if (clip.status === 'practice') {
      try { const r = await judgePair(model, gpu, clipId, dirname(clip.filePath), clip.durationSec ?? 20, clip.transcript ?? ''); if (r) why.push(`pair ${r}`); }
      catch (e) { log.warn(`clip ${clipId}: pair judge failed: ${(e as Error).message}`); }
      saveCalibration(clipId, shot, clip.transcript, { speech: fun.speech, visual: fun.visual, layoutPenalty: fun.layoutPenalty });
    }
    log.info(`clip ${clipId} judged on ${gpu ? 'GPU' : 'CPU'} in ${Date.now() - t0} ms: ${why.join(' | ')}`);
    Object.assign(fun, { judgeVersion: JUDGE_VERSION, judgeGpu: gpu ? 1 : 0, judgeWhy: why.join(' | ') });
  } catch (e) {
    log.warn(`clip ${clipId}: LLM judge skipped: ${(e as Error).message}`); // Ollama down: clip still goes to review
  }
  const signals = { ...(moment.signals ?? {}), ...Object.fromEntries(Object.entries(fun).filter(([, v]) => v !== undefined)) };
  const base = moment.score - funBonus((moment.signals ?? {}) as FunSignals, liveWeights()); // re-judge: don't add twice
  db.update(moments).set({ signals: signals as Record<string, number>, score: base + funBonus(fun, liveWeights()) }).where(eq(moments.id, moment.id)).run();
  if (layoutWarnings) { // replace the old layout warnings on a re-judge; they show on the card and block auto-keep
    const c = (clip.compliance ?? {}) as { warnings?: string[] };
    const warnings = [...(c.warnings ?? []).filter((w) => !w.startsWith(LAYOUT_PREFIX)), ...layoutWarnings];
    db.update(clips).set({ compliance: { ...c, warnings } }).where(eq(clips.id, clipId)).run();
  }
  // Practice clips are never reviewed or posted: keep the scores, delete the video files.
  if (clip.status === 'practice') return rmSync(dirname(clip.filePath), { recursive: true, force: true });
  if (notify) enqueue(db, 'review.notify', { clipId });
}
