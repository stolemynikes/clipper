// Picks chat messages the streamer reacts to, so the clip can show them as a temporary overlay.
// A message counts as "reacted to" when, within REACT_SEC after it was sent, the streamer says
// the sender's name or reads most of the message out loud.
import type { Word } from './subtitles.ts';

export interface ChatLine { t: number; user: string; text: string } // t = seconds from clip start
export interface Overlay extends ChatLine { s: number; e: number; row?: number } // shown from s to e (clip seconds); row = line in a burst stack

const REACT_SEC = 15;
const SHOW_SEC = 4;
const STOP = new Set(['the', 'and', 'you', 'are', 'for', 'that', 'this', 'with', 'not', 'but', 'what', 'was', 'his', 'her', 'its', 'just', 'have', 'like']);

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

export function matchChat(words: Word[], chat: ChatLine[], max = 3): Overlay[] {
  const spoken = words.map((w) => ({ s: w.s, n: tokens(w.w).join('') }));
  const hits: (Overlay & { score: number })[] = [];
  for (const m of chat) {
    if (/https?:|www\./i.test(m.text)) continue;
    const near = spoken.filter((w) => w.s >= m.t && w.s <= m.t + REACT_SEC);
    if (!near.length) continue;
    const nameParts = tokens(m.user.replace(/\d+/g, ' ')).filter((t) => t.length >= 4);
    const nameAt = near.find((w) => nameParts.includes(w.n));
    const msg = tokens(m.text).filter((t) => t.length >= 3 && !STOP.has(t));
    const readAt = near.filter((w) => msg.includes(w.n));
    const read = msg.length >= 3 && new Set(readAt.map((w) => w.n)).size / msg.length >= 0.6;
    if (!nameAt && !read) continue;
    const s = Math.max(m.t, (nameAt ?? readAt[0]).s - 0.5);
    hits.push({ ...m, s, e: s + SHOW_SEC, score: (nameAt ? 2 : 0) + (read ? 1 + readAt.length / 10 : 0) });
  }
  const picked: Overlay[] = [];
  for (const h of hits.sort((a, b) => b.score - a.score)) {
    if (picked.length >= max) break;
    if (picked.some((p) => h.s < p.e && h.e > p.s)) continue;
    const { score: _, ...o } = h;
    picked.push({ ...o, text: o.text.length > 90 ? `${o.text.slice(0, 87)}...` : o.text });
  }
  return picked.sort((a, b) => a.s - b.s);
}

const BOTS = /^(nightbot|streamelements|streamlabs|moobot|fossabot|wizebot|sery_bot)$/i;
const BURST_MIN = 6; // messages in the burst window before it counts as chat going wild
const BURST_ROWS = 5;
const BURST_WIN = 7; // seconds
const BURST_X = 2; // burst rate must be this many times the moment's average: chat that is busy all along is not a burst

/** When chat explodes inside the kept clip [from, to]: a stack of real messages from the busiest BURST_WIN seconds,
 * popping in as they were sent and held until the burst ends. Empty when chat never goes wild, so most clips get none. */
export function burstChat(chat: ChatLine[], from: number, to: number): Overlay[] {
  const real = chat.filter((m) => !BOTS.test(m.user) && !m.text.startsWith('!') && !/https?:|www\.|\.(com|tv|gg)\b/i.test(m.text));
  const inClip = real.filter((m) => m.t >= from && m.t < to);
  let msgs: ChatLine[] = [], at = from;
  for (const m of inClip) {
    const a = Math.min(m.t, Math.max(from, to - BURST_WIN));
    const w = inClip.filter((x) => x.t >= a && x.t < a + BURST_WIN);
    if (w.length > msgs.length) [msgs, at] = [w, a];
  }
  if (msgs.length < BURST_MIN) return [];
  const ts = chat.map((m) => m.t);
  const avg = real.length / Math.max(1, Math.max(...ts) - Math.min(...ts));
  if (msgs.length / BURST_WIN < BURST_X * avg) return [];
  const step = Math.max(1, Math.floor(msgs.length / BURST_ROWS)); // spread picks over the whole burst
  const picked = msgs.filter((_, i) => i % step === 0).slice(0, BURST_ROWS);
  const hold = Math.min(to, at + BURST_WIN) + 1.5;
  return picked.map((m, row) => ({ ...m, s: m.t, e: hold, row, text: m.text.length > 40 ? `${m.text.slice(0, 37)}...` : m.text }));
}
