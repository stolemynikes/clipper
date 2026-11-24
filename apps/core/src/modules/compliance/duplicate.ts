// Same moment twice (a re-upload, overlapping VODs, a highlight of a stream we already clipped): compare transcripts.
// Word trigrams survive small Whisper differences between two encodes of the same audio.
import type { Db } from '../../db/client.ts';

const grams = (text: string) => {
  const w = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return new Set(w.slice(2).map((_, i) => `${w[i]} ${w[i + 1]} ${w[i + 2]}`));
};

/** Share of the smaller clip's trigrams that also occur in the other (0-1). Short texts never match. */
export function overlap(a: string, b: string): number {
  const ga = grams(a), gb = grams(b);
  const [small, big] = ga.size <= gb.size ? [ga, gb] : [gb, ga];
  if (small.size < 8) return 0; // under ~10 words: too little speech to call it the same moment
  let hit = 0;
  for (const g of small) if (big.has(g)) hit++;
  return hit / small.size;
}

export const DUPLICATE = 0.5;

/** Id of an earlier clip of this streamer with (mostly) the same speech, or null. */
export function findDuplicate(db: Db, streamerId: number, transcript: string): number | null {
  const rows = db.$client.prepare(`select c.id, c.transcript from clips c join moments m on m.id = c.moment_id join sources s on s.id = m.source_id
    where s.streamer_id = ? and c.transcript is not null`).all(streamerId) as { id: number; transcript: string }[];
  return rows.find((r) => overlap(transcript, r.transcript) >= DUPLICATE)?.id ?? null;
}
