// Title and hook for a clip from its transcript, via local Ollama. The caller falls back to fallbackTitle() when this fails.
import { eq } from 'drizzle-orm';
import { loadSettings } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { clips, moments } from '../../db/schema.ts';
import { logger } from '../../log.ts';
import { enqueue } from '../../queue/queue.ts';
import { stopWhisper } from '../editor/whisper.ts';
import { pickStyle, styleStats } from '../learner/title-style.ts';
import type { Kind } from '../learner/patterns.ts';
import { kindFor, tweaks } from '../practice/proposals.ts';
import { sourceContext } from '../vod-clipper/analyze.ts';

const log = logger('titles');
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

export type TitleOut = { title: string; hook: string };

/** Clean model output: one line, no tags or hashtags, capped. Throws on empty so the caller uses the fallback. */
export function cleanTitle(raw: Partial<TitleOut>, max = 70): TitleOut {
  const fix = (s: unknown, n: number) => {
    const t = String(s ?? '').replace(/[<>#\n\r"]/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, '')}…` : t;
  };
  const out = { title: fix(raw.title, max), hook: fix(raw.hook, 40) };
  if (out.title.length < 4) throw new Error('model gave no usable title');
  return out;
}

export type TitleStyle = 'mild' | 'bold';
const STYLE: Record<TitleStyle, string> = {
  mild: 'Clickbait that delivers: open a curiosity gap about the most surprising, emotional or dramatic part, but hide the payoff (tease who, what or how it ends, do not tell it). One word in CAPS is allowed.',
  bold: 'Maximum clickbait: the most extreme true framing, big emotion and stakes, cliffhanger, hide the payoff completely ("He LOST it when...", "This went TOO far"). Up to two words in CAPS, "..." at the end is allowed.',
};

export function titlePrompt(transcript: string, streamer: string, style: TitleStyle = 'mild', top = tweaks().titleExamples ?? []) {
  // Top titles from an approved study proposal: style examples only, never facts for this clip.
  const week = top.length ? `\n  Most-viewed gaming Shorts this week were titled (copy the style, not the content): ${top.map((t) => `"${t.replace(/["\n]/g, ' ').slice(0, 80)}"`).join(', ')}.` : '';
  return `You write titles for short vertical gaming clips (TikTok, YouTube Shorts) of the streamer ${streamer}.
Transcript of the clip:
"""${transcript.slice(0, 2000)}"""

Return JSON with:
- "moment": one plain sentence: what really happens in this clip, only facts from the transcript.
- "title": 30-50 characters, in the language of the transcript. ${STYLE[style]} Use stakes, conflict, a specific number or name from the transcript, or a reaction ("He did NOT expect this", "Why chat turned on Lacy"). Put the strongest words first.
  Like the most-viewed clipper Shorts: name ${streamer} in the first 3 words and name the other people from the transcript ("Clix EXPOSED for faking...", "Silky Shows Up 2 Days Late..."); drama words (EXPOSED, argue, couldn't believe) only when true.${week}
  The title must be true for the "moment" sentence. Never promise anything that is not in the transcript: YouTube removes titles that mislead about the video.
  No hashtags, no quotes, not the word "streamer". End with exactly one emoji from: 😭 💀 😂 🥀.
- "hook": max 6 words shown on screen in the first second, same language, a teaser that makes people stay (not the same words as the title). Vary the wording: avoid "actually".`;
}

export async function generateTitle(transcript: string, streamer: string, model: string, style: TitleStyle = 'mild', kind: Kind = 'gaming'): Promise<TitleOut> {
  const tw = tweaks(undefined, kind);
  const t0 = Date.now();
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model, stream: false, think: false,
      keep_alive: '2m', // free VRAM soon: Whisper needs it for the next render
      format: { type: 'object', properties: { moment: { type: 'string' }, title: { type: 'string' }, hook: { type: 'string' } }, required: ['moment', 'title', 'hook'] },
      options: { temperature: 0.7 },
      messages: [{ role: 'user', content: titlePrompt(transcript, streamer, style, tw.titleExamples ?? []) }],
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${model} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json() as { message?: { content?: string } };
  const out = cleanTitle(JSON.parse(j.message?.content ?? '{}'), tw.titleMax);
  log.info(`title by ${model} in ${Date.now() - t0} ms`);
  return out;
}

/** Title + hook for a transcript, or null (then publish uses fallbackTitle). Runs before the final encode so the hook is burned in. */
export async function makeTitle(transcript: string | null, streamer: string, style: TitleStyle, kind: Kind = 'gaming'): Promise<(TitleOut & { style: TitleStyle }) | null> {
  if (!transcript || transcript.split(' ').length < 8) return null;
  stopWhisper(); // Whisper and the LLM don't both fit in 12 GB VRAM; Whisper restarts on the next render
  try {
    return { ...(await generateTitle(transcript, streamer, loadSettings().titles?.model ?? 'gemma4:12b', style, kind)), style };
  } catch (e) {
    log.warn(`no title, using the fallback: ${(e as Error).message}`);
    return null;
  }
}

/** Re-title job (older clips). New clips get their title inside the render job. */
export async function titleClip(db: Db, { clipId }: { clipId: number }, notify = true) {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) return;
  const moment = db.select().from(moments).where(eq(moments.id, clip.momentId)).get()!;
  const { cfg } = sourceContext(db, moment.sourceId);
  const t = await makeTitle(clip.transcript, cfg.name, pickStyle(styleStats(db)), kindFor(cfg));
  if (t) db.update(clips).set({ title: t.title, hook: t.hook, titleStyle: t.style }).where(eq(clips.id, clipId)).run();
  if (notify) enqueue(db, 'review.notify', { clipId });
}
