import { test } from "node:test";
import assert from "node:assert/strict";
import { pickMoments, scoreWindows, type ScoringConfig, type ChatMessage } from "./scoring.ts";

const cfg: ScoringConfig = {
  windowSec: 5,
  topN: 10,
  leadInSec: [30, 60],
  weights: { chatRate: 1, emoteScore: 0.8, viewerClipHits: 2, audioPeak: 0.5 },
  emotes: { KEKW: 1, LUL: 1 },
};
const limits = { minSec: 15, maxSec: 60 };

// 1 msg/sec background chat over `dur` seconds, plus bursts at given times
function chat(dur: number, bursts: number[] = [], text = "KEKW"): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = 0; t < dur; t++) out.push({ t, text: "hi" });
  for (const b of bursts) for (let k = 0; k < 40; k++) out.push({ t: b + (k % 5), text });
  return out;
}

test("chat burst becomes the top moment, ending at the peak window", () => {
  const m = pickMoments({ durationSec: 600, chat: chat(600, [300]) }, cfg, limits);
  assert.equal(m[0].peakAt, 300);
  assert.equal(m[0].end, 305);
  assert.equal(m[0].start, 245); // 60s lead-in capped by maxSec
});

test("flat chat yields no moments", () => {
  assert.deepEqual(pickMoments({ durationSec: 600, chat: chat(600) }, cfg, limits), []);
});

test("emotes outweigh plain chat at equal rate", () => {
  const msgs = chat(600, [100], "hello").concat(chat(0, [400], "KEKW LUL"));
  const w = scoreWindows({ durationSec: 600, chat: msgs }, cfg);
  assert.ok(w[80].score > w[20].score);
});

test("viewer clips count per overlapping window", () => {
  const w = scoreWindows({ durationSec: 60, chat: [], viewerClips: [{ offset: 10, duration: 10 }, { offset: 12, duration: 3 }] }, cfg);
  assert.deepEqual(w.map((x) => x.signals.viewerClipHits), [0, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("overlapping peaks merge only within maxSec, distant peaks stay separate", () => {
  const m = pickMoments({ durationSec: 1200, chat: chat(1200, [300, 310, 900]) }, cfg, limits);
  assert.equal(m.length, 2); // 310 can't merge (would exceed 60s) and overlaps, so it's dropped
  assert.ok(m.every((x) => x.end - x.start <= limits.maxSec));
  assert.deepEqual(m.map((x) => x.peakAt).sort((a, b) => a - b), [300, 900]);
});

test("respects topN and clip start never below 0", () => {
  const m = pickMoments({ durationSec: 3000, chat: chat(3000, [10, 500, 1000, 1500, 2000]) }, { ...cfg, topN: 3 }, limits);
  assert.equal(m.length, 3);
  const early = pickMoments({ durationSec: 600, chat: chat(600, [10]) }, cfg, limits);
  assert.equal(early[0].start, 0);
});
