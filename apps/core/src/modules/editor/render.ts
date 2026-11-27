// ffmpeg 9:16 render: facecam on top (1080x768), gameplay below (1080x1152), captions burned in.
export interface Rect { x: number; y: number; w: number; h: number } // fractions of the source frame

export interface Layout { scene?: 'cam' | 'fullcam' | 'nocam'; cam?: Rect | null; content?: Rect | null; fit?: 'full' | 'stack'; faces?: number; face?: Rect; pan?: [number, number][] } // from workers/face_track.py; pan: fullcam crop-left keyframes [t, x] (followPath)

const BOX = { x: 16, w: 560, h: 340 }; // chat box / card stack in a 1080x1920 frame (CHAT_BOX)
const TOP_SAFE = 150; // below the platform's top tabs

const CAP_HALF = 90; // captions are ~2 lines centered on captionY
const CAP_MAX = 1560; // lowest caption center: above the app's bottom-left text

/** fullcam face in output pixels (head = top of the hair), or null when there is no face to keep clear. */
function faceBand(layout: Layout) {
  const f = layout.face, c = layout.content;
  if (layout.scene !== 'fullcam' || !f || !c) return null;
  const y = (f.y - c.y) / c.h * 1920, h = f.h / c.h * 1920;
  // BlazeFace box starts at the brows: hair sits ~0.45 box heights above (measured on lacy, 912)
  return { x0: (f.x - c.x) / c.w * 1080, x1: (f.x + f.w - c.x) / c.w * 1080, head: y - 0.45 * h, chin: y + h };
}

/** fullcam: caption center y off the face: under the chin, else over the hair, else as low as allowed (covers only the chin). */
export function captionSpot(layout: Layout, def = 1300): number {
  const b = faceBand(layout);
  if (!b) return def;
  if (b.chin + 16 + CAP_HALF <= CAP_MAX) return Math.max(def, Math.round(b.chin + 16 + CAP_HALF));
  if (b.head - 16 - CAP_HALF >= TOP_SAFE) return Math.round(b.head - 16 - CAP_HALF);
  return CAP_MAX;
}

/** On-screen title center y, or null when it would cover the face. cam: over the streamer's chest at the cam panel's bottom
 *  (captions sit at the seam below); fullcam: above the hair; nocam: over the blurred bg above the content. */
export function hookSpot(layout: Layout): number | null {
  if (layout.cam) return 690 + stackTop(layout);
  const b = faceBand(layout);
  if (!b) return 470;
  return b.head - 16 - 80 >= TOP_SAFE ? Math.round(b.head - 16 - 80) : null; // title wraps to 2 lines max: ~80 px half
}

/** fullcam: top y of the chat box where it covers neither the streamer's head nor the captions; below the chin first, then above the hair.
 *  null = no free spot (box dropped). Other layouts keep their fixed spot (def). */
export function chatSpot(layout: Layout, captionY: number, def = 400): number | null {
  const b = faceBand(layout);
  if (!b) return def;
  if (b.x1 < BOX.x - 16 || b.x0 > BOX.x + BOX.w + 16) return def; // face is beside the box
  if (b.chin + 16 + BOX.h <= captionY - CAP_HALF) return Math.round(b.chin + 16);
  if (b.head - 16 - BOX.h >= TOP_SAFE && (captionY > b.head || TOP_SAFE + BOX.h + 16 <= captionY - CAP_HALF)) return TOP_SAFE;
  return null;
}

/** Rendered fullcam frames (face boxes as fractions of the 9:16 frame): why the face is not well framed, or null. */
export function faceTrouble(frames: Rect[][]): string | null {
  if (!frames.length) return null;
  const big = frames.map((fs) => fs.filter((f) => f.w >= 0.2).sort((a, b) => b.w - a.w)[0]);
  const seen = big.filter((f): f is Rect => !!f);
  if (seen.length < Math.ceil(frames.length * 0.4)) return 'face not found in most frames (cut off?)';
  const edge = seen.filter((f) => f.x <= 0.01 || f.x + f.w >= 0.99).length;
  if (edge >= 2) return 'face touches the frame edge';
  const cx = seen.map((f) => f.x + f.w / 2).sort((a, b) => a - b)[Math.floor(seen.length / 2)];
  return Math.abs(cx - 0.5) > 0.22 ? 'face off center' : null;
}

/** fit stack: cam (768) + whole game side scaled to 1080 wide, as one block centered on blur. Returns the block's top y (0 otherwise). */
export function stackTop(layout: Layout): number {
  if (layout.fit !== 'stack' || !layout.content) return 0;
  // shortcut: assumes a 16:9 source (Twitch, YouTube); read the real size if other sources come in.
  const gh = 2 * Math.round(540 * layout.content.h * 9 / (layout.content.w * 16));
  return Math.max(0, Math.round((1920 - 768 - gh) / 2));
}

const crop = (r: Rect) => `crop=iw*${r.w}:ih*${r.h}:iw*${r.x}:ih*${r.y}`;

const DEAD = 0.04; // the crop only moves when the face drifts this far (of frame width) from where it points: no jitter
/** Face centers every ~0.5 s (face_track.py track, null = lost) to crop-left keyframes [t, x] for a crop `cw` wide.
 *  Lost face holds the last spot; ±1 s average + dead zone keep it calm; points on a straight line are dropped. */
export function followPath(raw: [number, number | null][], cw: number, x0: number): [number, number][] {
  if (!raw.length) return [[0, x0]];
  let hold = raw.find(([, c]) => c != null)?.[1] ?? x0 + cw / 2;
  const cx = raw.map(([, c]) => (hold = c ?? hold));
  // median, not mean: one bad sample (hand, head turn) must not drag the crop
  const avg = cx.map((_, i) => { const w = cx.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b); return w[w.length >> 1]; });
  let cur = avg[0];
  const pts = avg.map((c, i): [number, number] => {
    if (Math.abs(c - cur) > DEAD) cur = c - Math.sign(c - cur) * DEAD;
    return [raw[i][0], +Math.min(Math.max(cur - cw / 2, 0), 1 - cw).toFixed(4)];
  });
  return pts.filter((p, i) => i === 0 || i === pts.length - 1 || Math.abs(p[1] - pts[i - 1][1]) + Math.abs(pts[i + 1][1] - p[1]) > 1e-4
    && Math.abs((p[1] - pts[i - 1][1]) / (p[0] - pts[i - 1][0]) - (pts[i + 1][1] - p[1]) / (pts[i + 1][0] - p[0])) > 1e-3);
}

/** ffmpeg crop x as a piecewise-linear function of t (x is evaluated per frame; w/h are not, so the crop only pans). */
export function panExpr(keys: [number, number][]): string {
  let e = String(keys[keys.length - 1][1]);
  for (let i = keys.length - 2; i >= 0; i--) {
    const [t0, a] = keys[i], [t1, b] = keys[i + 1];
    e = `if(lt(t,${t1}),${a}+${+(b - a).toFixed(4)}*(t-${t0})/${+(t1 - t0).toFixed(2)},${e})`;
  }
  return `if(lt(t,${keys[0][0]}),${keys[0][1]},${e})`;
}

const cropFollow = (r: Rect, keys?: [number, number][]) => (keys && keys.length > 1 ? `crop=iw*${r.w}:ih*${r.h}:'iw*(${panExpr(keys)})':ih*${r.y}` : crop(r));
const fill = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;

/** cam: cam on top (1080x768), content below (1080x1152; fit full: whole frame on blur). nocam: content whole, centered on a blurred
 * copy of itself (a 9:16 crop cuts off screens and menus). fullcam: content fills 9:16. */
/** chat: input 1 (transparent Twitch chat render) laid over the video from `at` for `dur` seconds, under the captions. */
export function filterGraph(layout: Layout, assFile: string, fontsDir: string, chat?: { at: number; dur: number; x: number; y: number }): string {
  const subs = `ass=${assFile}:fontsdir=${fontsDir}`;
  const end = chat
    // PTS-STARTPTS: the chat render does not start at t=0, so fade times would miss without it. trim: fade-out always fully inside.
    ? `[pre];[1:v]setpts=PTS-STARTPTS,trim=duration=${chat.dur.toFixed(2)},fade=in:st=0:d=0.3:alpha=1,fade=out:st=${Math.max(0, chat.dur - 0.5).toFixed(2)}:d=0.5:alpha=1,setpts=PTS+${chat.at.toFixed(2)}/TB[ch];`
      + `[pre][ch]overlay=${chat.x}:${chat.y}:eof_action=pass,${subs}[v]`
    : `,${subs}[v]`;
  const { cam, content } = layout;
  if (!cam && layout.scene === 'nocam' && content) {
    return `[0:v]split=2[a][b];[a]${fill(1080, 1920)},boxblur=30:2,eq=brightness=-0.2[bg];`
      + `[b]${crop(content)},scale=1080:-2,setsar=1[fg];[bg][fg]overlay=0:(H-h)/2${end}`;
  }
  if (!cam) return `[0:v]${content ? cropFollow(content, layout.pan) : 'crop=ih*9/16:ih'},${fill(1080, 1920)}${end}`;
  if (layout.fit === 'stack' && content) {
    // Cam and game stay joined; the spare height is split above and below (owner, Nov 2026).
    return `[0:v]split=3[a][b][c];[a]${crop(cam)},${fill(1080, 768)}[top];[b]${fill(1080, 1920)},boxblur=30:2,eq=brightness=-0.2[bg];`
      + `[c]${crop(content)},scale=1080:-2,setsar=1[g];[top][g]vstack[st];[bg][st]overlay=0:(H-h)/2${end}`;
  }
  return [
    `[0:v]split=2[a][b]`,
    `[a]${crop(cam)},${fill(1080, 768)}[top]`,
    ...(layout.fit === 'full' && content
      // Static screen (browser, tweet): whole frame on a blurred copy instead of a crop that cuts the page.
      ? [`[b]split=2[c][d]`, `[c]${fill(1080, 1152)},boxblur=30:2,eq=brightness=-0.2[bb]`,
        `[d]${crop(content)},scale=1080:-2,setsar=1[bf]`, `[bb][bf]overlay=0:(H-h)/2[bot]`]
      : [`[b]${content ? crop(content) : 'crop=ih*1080/1152:ih'},${fill(1080, 1152)}[bot]`]),
    `[top][bot]vstack${end}`,
  ].join(';');
}

/** Bitrate capped so a 60s clip stays under Telegram's 50MB bot upload limit. */
/** Music spans with nobody talking (0.3s margin around words): those parts get turned down. */
export function quietMusic(music: [number, number][], words: { s: number; e: number }[], pad = 0.3): [number, number][] {
  const out: [number, number][] = [];
  for (const [a0, b] of music) {
    let a = a0;
    for (const w of words) {
      if (w.e + pad <= a || w.s - pad >= b) continue;
      if (w.s - pad > a + 0.5) out.push([a, w.s - pad]);
      a = Math.max(a, w.e + pad);
    }
    if (b - a > 0.5) out.push([a, b]);
  }
  return out;
}

/** ffmpeg -af value that lowers volume inside the given spans (null when nothing to duck).
 * Gaps under 1.5s are bridged and spans under 2s skipped, with 0.5s ramps: no audible pumping. -6dB keeps game sound audible. */
export function duckFilter(spans: [number, number][], vol = 0.5, ramp = 0.5): string | null {
  const merged: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = merged.at(-1);
    if (last && a - last[1] < 1.5) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const keep = merged.filter(([a, b]) => b - a >= 2);
  return keep.length
    ? keep.map(([a, b]) => `volume='1-${1 - vol}*clip(min((t-${a.toFixed(2)})/${ramp},(${b.toFixed(2)}-t)/${ramp}),0,1)':eval=frame`).join(',')
    : null;
}

/** Same loudness on every clip (TikTok/Shorts play around -14 LUFS); LRA 7 tames shouting and explosions. */
export const loudnorm = (lufs = -14) => `loudnorm=I=${lufs}:LRA=7:TP=-1.5,aresample=48000`; // a sound proposal may change lufs
export const LOUDNORM = loudnorm();

const videoCodec = (encoder: string) => encoder === 'h264_nvenc'
  ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-b:v', '5M', '-maxrate', '6M', '-bufsize', '10M']
  : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '6M', '-bufsize', '10M'];

/** Cold open: the first whole words of the payoff (clip seconds, from `peak`), 1..max s long. null = no clean cut there. */
export function teaserSpan(words: { s: number; e: number }[], peak: number, max = 2.5): [number, number] | null {
  const ws = words.filter((w) => w.s >= peak - 0.3);
  if (!ws.length) return null;
  const a = Math.max(0, ws[0].s - 0.1), last = ws.filter((w) => w.e + 0.15 - a <= max).pop();
  return last && last.e - a >= 1 ? [+a.toFixed(2), +(last.e + 0.15).toFixed(2)] : null;
}

/** Rendered clip with [a, b] of itself in front, joined by a short picture + sound crossfade. */
export function coldOpenArgs(input: string, output: string, [a, b]: [number, number], encoder: string, fade = 0.3): string[] {
  const g = `[0:v]split[v0][v1];[v0]trim=${a}:${b},setpts=PTS-STARTPTS[t];[v1]setpts=PTS-STARTPTS[m];`
    + `[t][m]xfade=transition=fade:duration=${fade}:offset=${+(b - a - fade).toFixed(2)},format=yuv420p[v];`
    + `[0:a]asplit[a0][a1];[a0]atrim=${a}:${b},asetpts=PTS-STARTPTS[ta];[a1]asetpts=PTS-STARTPTS[ma];[ta][ma]acrossfade=d=${fade}[a]`;
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-filter_complex', g, '-map', '[v]', '-map', '[a]',
    ...videoCodec(encoder), '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output];
}

export function ffmpegArgs(input: string, output: string, graph: string, encoder: string, startSec = 0, audioFilter: string | null = null, durSec: number | null = null, overlayInput: string | null = null, lufs = -14): string[] {
  const video = videoCodec(encoder);
  return ['-y', '-hide_banner', '-loglevel', 'error', ...(startSec > 0 ? ['-ss', startSec.toFixed(2)] : []), ...(durSec ? ['-t', durSec.toFixed(2)] : []), '-i', input, ...(overlayInput ? ['-i', overlayInput] : []), '-filter_complex', graph, '-map', '[v]', '-map', '0:a?',
    '-af', audioFilter ? `${audioFilter},${loudnorm(lufs)}` : loudnorm(lufs),
    ...video, '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output];
}
