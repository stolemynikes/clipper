import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadSettings } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { clips, moments } from '../../db/schema.ts';
import { paths } from '../../env.ts';
import { readHardwareConfig } from '../../hardware.ts';
import { logger } from '../../log.ts';
import { runCmd } from '../../proc.ts';
import { enqueue } from '../../queue/queue.ts';
import { sourceContext } from '../vod-clipper/analyze.ts';
import { type ChatLine, matchChat } from './chat-overlay.ts';
import { ffmpegArgs, filterGraph, type Layout, type Rect } from './render.ts';
import { buildAss, type Word } from './subtitles.ts';

const log = logger('editor');
const fwd = (p: string) => p.replaceAll('\\', '/');
const SILENT_DB = -50; // peak below this = mic off / muted stream start: nothing worth clipping

/** Cam box + content crop per clip (cams differ per streamer and per scene); config facecam as fallback. */
async function detectLayout(src: string, fallback: Rect | null): Promise<Layout> {
  try {
    const out = await runCmd(paths.pythonBin, [join(paths.rootDir, 'workers', 'face_track.py'),
      JSON.stringify({ input: src, hint: fallback, model: join(paths.rootDir, 'assets', 'models', 'blaze_face_short_range.tflite') })]);
    const r = JSON.parse(out) as Layout & { scene: string };
    log.info(`layout: ${r.scene}`);
    return r;
  } catch (e) {
    log.warn(`face_track failed, using config facecam: ${(e as Error).message}`);
    return { cam: fallback };
  }
}

/** Seconds to cut from the start when nobody talks for over 3s; keeps 1s before the first word. */
export const deadAirLead = (words: Word[]) => (words[0] && words[0].s > 3 ? words[0].s - 1 : 0);

export async function renderClip(db: Db, { momentId }: { momentId: number }) {
  const moment = db.select().from(moments).where(eq(moments.id, momentId)).get();
  if (!moment) throw new Error(`moment ${momentId} not found`);
  if (db.select().from(clips).where(eq(clips.momentId, momentId)).get()) return log.info(`moment ${momentId} already rendered`);
  const { source, cfg } = sourceContext(db, moment.sourceId);
  const settings = loadSettings();
  const hw = readHardwareConfig();
  const dir = join(paths.dataDir, 'clips', String(momentId));
  mkdirSync(dir, { recursive: true });
  db.update(moments).set({ status: 'rendering' }).where(eq(moments.id, momentId)).run();

  // Only the moment itself is downloaded, never the whole VOD.
  const src = join(dir, 'src.mp4');
  await runCmd('yt-dlp', ['-q', '--no-warnings', '--force-overwrites', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--download-sections', `*${moment.startSec}-${moment.endSec}`, '--merge-output-format', 'mp4', '-o', src, source.url]);

  const out = await runCmd(paths.pythonBin, [join(paths.rootDir, 'workers', 'transcribe.py'),
    JSON.stringify({ input: src, model: hw?.whisperModelVod ?? 'large-v3', language: null })]);
  const t = JSON.parse(out) as { words: Word[]; peakDb?: number };
  const { peakDb } = t;
  // Dead air at the start loses viewers in the first second: start 1s before the first word.
  const lead = deadAirLead(t.words);
  const words = t.words.map((w) => ({ ...w, s: w.s - lead, e: w.e - lead }));
  if ((peakDb ?? 0) < SILENT_DB) {
    rmSync(src, { force: true });
    db.update(moments).set({ status: 'skipped' }).where(eq(moments.id, momentId)).run();
    return log.warn(`moment ${momentId} skipped: silent audio (${peakDb} dB)`);
  }

  const layout = await detectLayout(src, cfg.facecam ?? null);
  const chatFile = join(dir, 'chat.json');
  const chat = existsSync(chatFile)
    ? matchChat(t.words, JSON.parse(readFileSync(chatFile, 'utf8')) as ChatLine[]).map((c) => ({ ...c, s: Math.max(0, c.s - lead), e: c.e - lead })).filter((c) => c.e > 0.5)
    : [];

  const durationSec = moment.endSec - moment.startSec - lead;
  const disclosure = (cfg.campaign?.disclosure ?? settings.clip.disclosure) ? settings.clip.disclosureText : null;
  writeFileSync(join(dir, 'subs.ass'), buildAss({
    words, durationSec, tag: cfg.tag, disclosure, disclosureSec: settings.clip.disclosureSec, chat,
    style: cfg.captionStyle ?? settings.clip.captionStyle,
    // nocam content sits at y~555-1365 on the blurred bg: captions just below it. fullcam: lower, chat card higher.
    captionY: layout.cam ? undefined : layout.scene === 'nocam' ? 1460 : 1300, chatY: layout.cam ? 820 : 400,
  }));

  // cwd = clip dir + relative forward-slash paths: avoids escaping "E:" inside the ffmpeg filter string.
  const graph = filterGraph(layout, 'subs.ass', fwd(relative(dir, join(paths.rootDir, 'assets', 'fonts'))));
  await runCmd('ffmpeg', ffmpegArgs('src.mp4', 'clip.mp4', graph, hw?.encoder ?? 'libx264', lead), { cwd: dir });
  rmSync(src, { force: true });

  const clip = db.insert(clips).values({ momentId, filePath: join(dir, 'clip.mp4'), durationSec }).returning().get();
  db.update(moments).set({ status: 'rendered' }).where(eq(moments.id, momentId)).run();
  enqueue(db, 'review.notify', { clipId: clip.id });
  log.info(`clip ${clip.id} rendered (${durationSec.toFixed(0)}s, ${words.length} words)`);
}
