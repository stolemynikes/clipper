// Title and hook for a clip from its transcript, via local Ollama. The caller falls back to fallbackTitle() when this fails.
import { eq } from 'drizzle-orm';
import { loadSettings } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { clips, moments } from '../../db/schema.ts';
import { logger } from '../../log.ts';
import { enqueue } from '../../queue/queue.ts';
import { stopWhisper } from '../editor/whisper.ts';
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

export function titlePrompt(transcript: string, streamer: string) {
  return `You write titles for short vertical gaming clips (TikTok, YouTube Shorts) of the streamer ${streamer}.
Transcript of the clip:
"""${transcript.slice(0, 2000)}"""

Return JSON with:
- "moment": one plain sentence: what really happens in this clip, only facts from the transcript.
- "title": 30-50 characters, in the language of the transcript. Clickbait that delivers: open a curiosity gap about the most surprising, emotional or dramatic part, but hide the payoff (tease who, what or how it ends, don't tell it). Use stakes, conflict, a specific number or name from the transcript, or a reaction ("He did NOT expect this", "Why chat turned on Lacy"). Put the strongest words first. One word in CAPS is allowed.
  The title must be true for the "moment" sentence. Never promise anything that is not in the transcript: YouTube removes titles that mislead about the video.
  No hashtags, no emojis, no quotes, not the word "streamer".
- "hook": max 6 words shown on screen in the first second, same language, a teaser that makes people stay (not the same words as the title). Vary the wording: avoid "actually".`;
}

export async function generateTitle(transcript: string, streamer: string, model: string): Promise<TitleOut> {
  const t0 = Date.now();
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model, stream: false, think: false,
      keep_alive: '2m', // free VRAM soon: Whisper needs it for the next render
      format: { type: 'object', properties: { moment: { type: 'string' }, title: { type: 'string' }, hook: { type: 'string' } }, required: ['moment', 'title', 'hook'] },
      options: { temperature: 0.7 },
      messages: [{ role: 'user', content: titlePrompt(transcript, streamer) }],
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${model} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json() as { message?: { content?: string } };
  const out = cleanTitle(JSON.parse(j.message?.content ?? '{}'));
  log.info(`title by ${model} in ${Date.now() - t0} ms`);
  return out;
}

/** Job after render: title + hook, then the review push. A failed title never blocks review (publish uses fallbackTitle). */
// shortcut: the hook is stored but not burned into the video (title runs after render), burn it in when hooks are A/B-tested.
export async function titleClip(db: Db, { clipId }: { clipId: number }, notify = true) {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) return;
  const moment = db.select().from(moments).where(eq(moments.id, clip.momentId)).get()!;
  const { cfg } = sourceContext(db, moment.sourceId);
  if (clip.transcript && clip.transcript.split(' ').length >= 8) {
    stopWhisper(); // Whisper and the LLM don't both fit in 12 GB VRAM; Whisper restarts on the next render
    try {
      const t = await generateTitle(clip.transcript, cfg.name, loadSettings().titles?.model ?? 'gemma4:12b');
      db.update(clips).set({ title: t.title, hook: t.hook }).where(eq(clips.id, clipId)).run();
    } catch (e) {
      log.warn(`no title for clip ${clipId}, using the fallback: ${(e as Error).message}`);
    }
  }
  if (notify) enqueue(db, 'review.notify', { clipId });
}
