// One-off: do the fun signals predict views? Runs laugh/cheer + LLM judges on the study viewer clips (real view counts),
// label = above this streamer's median views. Resumable: results cached in data/study-eval.json.
// Then: single-signal AUC, and a logistic regression with/without pair products (signals interact), leave-one-streamer-out CV.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings } from '../config.ts';
import { paths } from '../env.ts';
import { ask, frames, speechPrompt, useGpu, VISUAL_PROMPT } from '../modules/judge/judge.ts';
import { auc } from '../modules/learner/weights.ts';
import { runCmd } from '../proc.ts';

const FEATS = ['laughMax', 'cheerMax', 'speech', 'visual', 'wps', 'sec'] as const;
type Row = { streamer: string; slug: string; views: number; sec: number; text: string; wps: number; laughRatio?: number; cheerRatio?: number; laughMax?: number; cheerMax?: number; speech?: number; visual?: number };
const dir = join(paths.dataDir, 'study'), out = join(paths.dataDir, 'study-eval.json');
const cache: Record<string, Row> = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const model = loadSettings().titles?.model ?? 'gemma4:12b';

const rows: Row[] = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
  const streamer = f.slice(0, -3);
  // Twitch viewer clips only: "### 42,187 views · 60s · title\nhttps://www.twitch.tv/x/clip/<slug>" ... "- Text: ..."
  for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/^### ([\d,]+) views · (\d+)s · .*\nhttps:\/\/www\.twitch\.tv\/[^/]+\/clip\/(\S+)[\s\S]*?^- Words per second: ([\d.]+)\n- Text: (.*)$/gm)) {
    const file = join(dir, streamer, `${m[3]}.mp4`);
    if (existsSync(file)) rows.push({ streamer, slug: m[3], views: Number(m[1].replaceAll(',', '')), sec: Number(m[2]), wps: Number(m[4]), text: m[5] });
  }
}
console.log(`${rows.length} study clips`);

for (const r of rows) {
  const file = join(dir, r.streamer, `${r.slug}.mp4`);
  Object.assign(r, cache[r.slug]);
  if (r.laughMax === undefined) {
    const m = JSON.parse(await runCmd(paths.pythonBin, [join(paths.rootDir, 'workers', 'music_detect.py'), JSON.stringify({ input: file })]));
    Object.assign(r, { laughRatio: m.laughRatio, cheerRatio: m.cheerRatio, laughMax: m.laughMax, cheerMax: m.cheerMax });
  }
  if (r.visual === undefined) {
    const gpu = await useGpu(loadSettings().judge?.awayMin ?? 10);
    if (r.text.split(' ').length >= 8) r.speech = (await ask(model, gpu, speechPrompt(r.text, []))).score / 10; // no examples: they are these clips
    r.visual = (await ask(model, gpu, VISUAL_PROMPT, await frames(file, r.sec))).score / 10;
  }
  cache[r.slug] = r;
  writeFileSync(out, JSON.stringify(cache, null, 1));
}

// Label per streamer (view counts differ 100x between streamers).
const good = rows.map((r) => {
  const v = rows.filter((x) => x.streamer === r.streamer).map((x) => x.views).sort((a, b) => a - b);
  return r.views > v[v.length >> 1];
});
for (const k of FEATS) {
  const i = rows.map((r, j) => (typeof r[k] === 'number' ? j : -1)).filter((j) => j >= 0);
  console.log(`AUC ${k}: ${auc(i.map((j) => rows[j][k] as number), i.map((j) => good[j]))?.toFixed(2)} (n ${i.length})`);
}

// Features: z-scored, missing speech -> mean (0). Pairs = products of every two.
const base = (rs: Row[]) => {
  const cols = FEATS.map((k) => { const v = rs.map((r) => r[k]).filter((x): x is number => typeof x === 'number'); const m = v.reduce((a, b) => a + b, 0) / v.length; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1; return { k, m, sd }; });
  return rs.map((r) => cols.map(({ k, m, sd }) => (typeof r[k] === 'number' ? ((r[k] as number) - m) / sd : 0)));
};
const withPairs = (X: number[][]) => X.map((x) => [...x, ...x.flatMap((a, i) => x.slice(i + 1).map((b) => a * b))]);
function fit(X: number[][], y: boolean[], l2 = 1): number[] { // logistic regression, gradient descent, L2 against overfit
  const w = new Array(X[0].length + 1).fill(0);
  for (let it = 0; it < 2000; it++) {
    const g = new Array(w.length).fill(0);
    X.forEach((x, n) => { const p = 1 / (1 + Math.exp(-(w[0] + x.reduce((a, v, i) => a + v * w[i + 1], 0)))); const e = p - (y[n] ? 1 : 0); g[0] += e; x.forEach((v, i) => (g[i + 1] += e * v)); });
    for (let i = 0; i < w.length; i++) w[i] -= (0.1 * (g[i] + (i ? l2 * w[i] : 0))) / X.length;
  }
  return w;
}
const predict = (w: number[], x: number[]) => w[0] + x.reduce((a, v, i) => a + v * w[i + 1], 0);
for (const [name, feats] of [['linear', base(rows)], ['with pairs', withPairs(base(rows))]] as const) {
  const scores = new Array(rows.length).fill(0);
  for (const s of new Set(rows.map((r) => r.streamer))) { // train on 11 streamers, score the 12th
    const tr = rows.map((r, i) => (r.streamer !== s ? i : -1)).filter((i) => i >= 0);
    const w = fit(tr.map((i) => feats[i]), tr.map((i) => good[i]));
    rows.forEach((r, i) => { if (r.streamer === s) scores[i] = predict(w, feats[i]); });
  }
  console.log(`CV AUC ${name}: ${auc(scores, good)?.toFixed(2)}`);
}
const wAll = fit(base(rows), good);
console.log(`weights (all data, z-scored): ${FEATS.map((k, i) => `${k} ${wAll[i + 1].toFixed(2)}`).join(', ')}`);
