// ffmpeg 9:16 render: facecam on top (1080x768), gameplay below (1080x1152), captions burned in.
export interface Rect { x: number; y: number; w: number; h: number } // fractions of the source frame

export interface Layout { scene?: 'cam' | 'fullcam' | 'nocam'; cam?: Rect | null; content?: Rect | null; fit?: 'full' } // from workers/face_track.py

const crop = (r: Rect) => `crop=iw*${r.w}:ih*${r.h}:iw*${r.x}:ih*${r.y}`;
const fill = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;

/** cam: cam on top (1080x768), content below (1080x1152; fit full: whole frame on blur). nocam: content whole, centered on a blurred
 * copy of itself (a 9:16 crop cuts off screens and menus). fullcam: content fills 9:16. */
export function filterGraph(layout: Layout, assFile: string, fontsDir: string): string {
  const subs = `ass=${assFile}:fontsdir=${fontsDir}`;
  const { cam, content } = layout;
  if (!cam && layout.scene === 'nocam' && content) {
    return `[0:v]split=2[a][b];[a]${fill(1080, 1920)},boxblur=30:2,eq=brightness=-0.2[bg];`
      + `[b]${crop(content)},scale=1080:-2,setsar=1[fg];[bg][fg]overlay=0:(H-h)/2,${subs}[v]`;
  }
  if (!cam) return `[0:v]${content ? crop(content) : 'crop=ih*9/16:ih'},${fill(1080, 1920)},${subs}[v]`;
  return [
    `[0:v]split=2[a][b]`,
    `[a]${crop(cam)},${fill(1080, 768)}[top]`,
    ...(layout.fit === 'full' && content
      // Static screen (browser, tweet): whole frame on a blurred copy instead of a crop that cuts the page.
      ? [`[b]split=2[c][d]`, `[c]${fill(1080, 1152)},boxblur=30:2,eq=brightness=-0.2[bb]`,
        `[d]${crop(content)},scale=1080:-2,setsar=1[bf]`, `[bb][bf]overlay=0:(H-h)/2[bot]`]
      : [`[b]${content ? crop(content) : 'crop=ih*1080/1152:ih'},${fill(1080, 1152)}[bot]`]),
    `[top][bot]vstack,${subs}[v]`,
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

/** ffmpeg -af value that lowers volume inside the given spans (null when nothing to duck). */
export const duckFilter = (spans: [number, number][], vol = 0.25) =>
  spans.length ? spans.map(([a, b]) => `volume=${vol}:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`).join(',') : null;

export function ffmpegArgs(input: string, output: string, graph: string, encoder: string, startSec = 0, audioFilter: string | null = null): string[] {
  const video = encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-b:v', '5M', '-maxrate', '6M', '-bufsize', '10M']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '6M', '-bufsize', '10M'];
  return ['-y', '-hide_banner', '-loglevel', 'error', ...(startSec > 0 ? ['-ss', startSec.toFixed(2)] : []), '-i', input, '-filter_complex', graph, '-map', '[v]', '-map', '0:a?',
    ...(audioFilter ? ['-af', audioFilter] : []),
    ...video, '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output];
}
