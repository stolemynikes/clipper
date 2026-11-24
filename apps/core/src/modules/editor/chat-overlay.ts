// Picks chat messages the streamer reacts to, so the clip can show them as a temporary overlay.
// A message counts as "reacted to" when, within REACT_SEC after it was sent, the streamer says
// the sender's name or reads most of the message out loud.
import type { Word } from './subtitles.ts';

export interface ChatLine { t: number; user: string; text: string } // t = seconds from clip start
export interface Overlay extends ChatLine { s: number; e: number } // shown from s to e (clip seconds)

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
