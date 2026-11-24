// Scores fixed time windows of a VOD and picks the top-N clip-worthy moments.
// Pure functions: no I/O, so the money-deciding logic stays easy to test.

export interface ChatMessage { t: number; text: string; user?: string } // t = seconds from VOD start
export interface ViewerClip { offset: number; duration: number } // Twitch Clips API vod_offset

export interface ScoringConfig {
  windowSec: number;
  topN: number;
  leadInSec: [number, number];
  tailSec?: number; // keep this long after the peak window, so the reaction is in the clip
  weights: { chatRate: number; emoteScore: number; viewerClipHits: number; audioPeak: number };
  emotes: Record<string, number>;
}

export interface ClipLimits { minSec: number; maxSec: number }

export interface Signals { chatRate: number; emoteScore: number; viewerClipHits: number; audioPeak: number }

export interface Moment { start: number; end: number; score: number; peakAt: number; signals: Signals }

export interface ScoreInput {
  durationSec: number;
  chat: ChatMessage[];
  viewerClips?: ViewerClip[];
  audio?: number[]; // optional loudness per window (any scale), index = window
}

function zScores(values: number[]): number[] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
  return values.map((v) => (sd === 0 ? 0 : (v - mean) / sd));
}

export function scoreWindows(input: ScoreInput, cfg: ScoringConfig): { score: number; signals: Signals }[] {
  const w = cfg.windowSec;
  const n = Math.max(1, Math.ceil(input.durationSec / w));
  const counts = new Array(n).fill(0);
  const emotes = new Array(n).fill(0);
  const clipHits = new Array(n).fill(0);

  for (const m of input.chat) {
    const i = Math.floor(m.t / w);
    if (i < 0 || i >= n) continue;
    counts[i]++;
    for (const word of m.text.split(/\s+/)) emotes[i] += cfg.emotes[word] ?? 0;
  }
  for (const c of input.viewerClips ?? []) {
    const first = Math.max(0, Math.floor(c.offset / w));
    const last = Math.min(n - 1, Math.floor((c.offset + c.duration - 1e-9) / w));
    for (let i = first; i <= last; i++) clipHits[i]++;
  }

  const chatZ = zScores(counts.map((c) => c / w));
  const emoteZ = zScores(emotes);
  const audioZ = input.audio ? zScores(Array.from({ length: n }, (_, i) => input.audio![i] ?? 0)) : new Array(n).fill(0);
  const k = cfg.weights;

  return chatZ.map((_, i) => {
    const signals = { chatRate: chatZ[i], emoteScore: emoteZ[i], viewerClipHits: clipHits[i], audioPeak: audioZ[i] };
    const score = k.chatRate * signals.chatRate + k.emoteScore * signals.emoteScore
      + k.viewerClipHits * signals.viewerClipHits + k.audioPeak * signals.audioPeak;
    return { score, signals };
  });
}

// Best windows first; each becomes a clip ending at the peak window, starting leadIn before it
// (chat reacts late). Overlapping picks are merged while the result stays within maxSec.
export function pickMoments(input: ScoreInput, cfg: ScoringConfig, limits: ClipLimits): Moment[] {
  const w = cfg.windowSec;
  const windows = scoreWindows(input, cfg);
  const len = Math.min(limits.maxSec, Math.max(limits.minSec, cfg.leadInSec[1] + w));
  const order = windows.map((x, i) => ({ ...x, i })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const picked: Moment[] = [];

  for (const x of order) {
    if (picked.length >= cfg.topN) break;
    const end = Math.min(input.durationSec, (x.i + 1) * w + (cfg.tailSec ?? 0));
    const start = Math.max(0, end - len);
    if (end - start < limits.minSec) continue;
    const hit = picked.find((p) => start < p.end && end > p.start);
    if (!hit) {
      picked.push({ start, end, score: x.score, peakAt: x.i * w, signals: x.signals });
    } else if (Math.max(end, hit.end) - Math.min(start, hit.start) <= limits.maxSec) {
      hit.start = Math.min(start, hit.start);
      hit.end = Math.max(end, hit.end);
    }
  }
  return picked.sort((a, b) => b.score - a.score);
}
