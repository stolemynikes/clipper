// "Is it fun to watch?" signals per rendered clip, on top of chat and viewer clips (loud != funny):
// laughMax/cheerMax (YAMNet peak score, from music_detect; the share-of-frames ratio was ~always 0 under speech), speech (local LLM reads the transcript),
// visual (same LLM looks at 4 frames). They only change the score once the learner has proven them (weights start at 0).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { sourceContext } from '../vod-clipper/analyze.ts';
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

export async function frames(file: string, dur: number, width = 360): Promise<string[]> { // layout check: 540+, thin strips vanish at 360
  const out: string[] = [];
  for (const f of [0.2, 0.4, 0.6, 0.8]) {
    const jpg = await runCmd('powershell', ['-NoProfile', '-Command', // binary stdout via base64: runCmd returns text
      `$p=[IO.Path]::GetTempFileName()+'.jpg'; ffmpeg -v error -y -ss ${(dur * f).toFixed(1)} -i '${file.replace(/'/g, "''")}' -frames:v 1 -vf scale=${width}:-2 $p; [Convert]::ToBase64String([IO.File]::ReadAllBytes($p)); Remove-Item $p`]);
    out.push(jpg.trim());
  }
  return out;
}

/** Job: judge one clip, store the signals on its moment, add the proven part to the score, then ask for review. */
export async function judgeClip(db: Db, { clipId, notify = true }: { clipId: number; notify?: boolean }) {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) return;
  const moment = db.select().from(moments).where(eq(moments.id, clip.momentId)).get()!;
  const { cfg } = sourceContext(db, moment.sourceId);
  const s = loadSettings();
  const model = s.titles?.model ?? 'gemma4:12b';
  const music = (clip.compliance as { music?: FunSignals } | null)?.music;
  const fun: FunSignals & { judgeWhy?: string; judgeGpu?: number; layoutPenalty?: number } = // judgeWhy: text in the numeric signals JSON, for the review page
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
    if (existsSync(clip.filePath)) {
      const b = await ask(model, gpu, VISUAL_PROMPT, await frames(clip.filePath, clip.durationSec ?? 20));
      fun.visual = b.score / 10; why.push(`screen ${b.score}: ${b.why}`);
      const l = await askLayout(model, gpu, layoutRules(cfg.campaign), await frames(clip.filePath, clip.durationSec ?? 20, 540));
      fun.layoutPenalty = l.penalty; layoutWarnings = l.warnings;
      if (l.warnings.length) why.push(`layout -${l.penalty}: ${l.warnings.join('; ')}`);
    }
    log.info(`clip ${clipId} judged on ${gpu ? 'GPU' : 'CPU'} in ${Date.now() - t0} ms: ${why.join(' | ')}`);
    Object.assign(fun, { judgeGpu: gpu ? 1 : 0, judgeWhy: why.join(' | ') });
  } catch (e) {
    log.warn(`clip ${clipId}: LLM judge skipped: ${(e as Error).message}`); // Ollama down: clip still goes to review
  }
  const signals = { ...(moment.signals ?? {}), ...Object.fromEntries(Object.entries(fun).filter(([, v]) => v !== undefined)) };
  const base = moment.score - funBonus((moment.signals ?? {}) as FunSignals, learnedWeights()); // re-judge: don't add twice
  db.update(moments).set({ signals: signals as Record<string, number>, score: base + funBonus(fun, learnedWeights()) }).where(eq(moments.id, moment.id)).run();
  if (layoutWarnings) { // replace the old layout warnings on a re-judge; they show on the card and block auto-keep
    const c = (clip.compliance ?? {}) as { warnings?: string[] };
    const warnings = [...(c.warnings ?? []).filter((w) => !w.startsWith(LAYOUT_PREFIX)), ...layoutWarnings];
    db.update(clips).set({ compliance: { ...c, warnings } }).where(eq(clips.id, clipId)).run();
  }
  if (notify) enqueue(db, 'review.notify', { clipId });
}
