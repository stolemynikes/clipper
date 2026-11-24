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
import { burstChat, type ChatLine, matchChat } from './chat-overlay.ts';
import { trimWindow } from './trim.ts';
import { renderTwitchChat, vodIdOf } from './twitch-chat.ts';
import { checkClip, type Music } from '../compliance/compliance.ts';
import { findDuplicate } from '../compliance/duplicate.ts';
import { accountStats } from '../../review/setup.ts';
import { duckFilter, ffmpegArgs, filterGraph, type Layout, quietMusic, type Rect } from './render.ts';
import { buildAss, type Word } from './subtitles.ts';
import { makeTitle } from '../publisher/titles.ts';
import { pickStyle, styleStats } from '../learner/title-style.ts';
import { transcribe } from './whisper.ts';

const log = logger('editor');
const fwd = (p: string) => p.replaceAll('\\', '/');
const WEBSITE_PENALTY = 0.5;
const SILENT_DB = -50; // peak below this = mic off / muted stream start: nothing worth clipping

/** Cam box + content crop per clip (cams differ per streamer and per scene), measured on the kept part [start, end]. */
async function detectLayout(src: string, hint: Rect | null, start: number, end: number): Promise<Layout> {
  try {
    const out = await runCmd(paths.pythonBin, [join(paths.rootDir, 'workers', 'face_track.py'),
      JSON.stringify({ input: src, hint, start, end, model: join(paths.rootDir, 'assets', 'models', 'blaze_face_short_range.tflite') })]);
    const r = JSON.parse(out) as Layout & { scene: string };
    log.info(`layout: ${r.scene}`);
    return r;
  } catch (e) {
    // No face found = no cam on top: a guessed cam box shows a blurry wall when the scene has no webcam.
    log.warn(`face_track failed, showing the whole frame: ${(e as Error).message}`);
    return { scene: 'nocam', cam: null, content: { x: 0, y: 0, w: 1, h: 1 } };
  }
}

/** Background music share + spans (YAMNet). null when the check fails: compliance then warns. */
async function detectMusic(src: string): Promise<(Music & { musicSec: [number, number][] }) | null> {
  try {
    return JSON.parse(await runCmd(paths.pythonBin, [join(paths.rootDir, 'workers', 'music_detect.py'), JSON.stringify({ input: src })]));
  } catch (e) {
    log.warn(`music_detect failed: ${(e as Error).message}`);
    return null;
  }
}

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

  const t = await transcribe({ input: src, model: hw?.whisperModelVod ?? 'medium', language: null });
  const { peakDb } = t;
  // Keep only build-up + peak + reaction: start on a sentence, end after the reaction sentence.
  const sc = settings.scoring;
  const maxSec = cfg.campaign?.maxSec ?? settings.clip.maxSec;
  const peakRel = (moment.signals?.peakAt ?? moment.endSec - sc.windowSec - (sc.tailSec ?? 0)) - moment.startSec;
  const { start: lead, end: cut } = trimWindow({ words: t.words, durationSec: moment.endSec - moment.startSec, peakRel, windowSec: sc.windowSec,
    tailSec: sc.tailSec ?? 0, targetSec: settings.clip.targetSec ?? [settings.clip.minSec, maxSec], minSec: settings.clip.minSec, maxSec });
  const words = t.words.filter((w) => w.s >= lead && w.s < cut).map((w) => ({ ...w, s: w.s - lead, e: Math.min(w.e, cut) - lead }));
  if ((peakDb ?? 0) < SILENT_DB) {
    rmSync(src, { force: true });
    db.update(moments).set({ status: 'skipped' }).where(eq(moments.id, momentId)).run();
    return log.warn(`moment ${momentId} skipped: silent audio (${peakDb} dB)`);
  }

  const durationSec = cut - lead;
  const disclosure = (cfg.campaign?.disclosure ?? settings.clip.disclosure) ? settings.clip.disclosureText : null;
  const transcript = words.map((w) => w.w).join(' ');
  const music = await detectMusic(src);
  const used = accountStats(db).filter((a) => a.streamer === cfg.name).reduce((n, a) => n + a.earned, 0);
  const compliance = checkClip({
    campaign: cfg.campaign, tag: cfg.tag, durationSec, limits: { minSec: settings.clip.minSec, maxSec: cfg.campaign?.maxSec ?? settings.clip.maxSec },
    disclosureRequired: cfg.campaign?.disclosure ?? settings.clip.disclosure, disclosure, music,
    transcript, duplicateOf: source.streamerId ? findDuplicate(db, source.streamerId, transcript) : null,
    budget: cfg.campaign?.budget ? { used, total: cfg.campaign.budget } : null,
    sourceDate: null, // shortcut: VOD air date not stored yet, add it in the watcher when a brief sets sourceFrom strictly
  });
  if (!compliance.ok) {
    rmSync(src, { force: true });
    db.update(moments).set({ status: 'skipped' }).where(eq(moments.id, momentId)).run();
    return log.warn(`moment ${momentId} blocked: ${compliance.blocks.join('; ')}`);
  }

  const layout = await detectLayout(src, cfg.facecam ?? null, lead, cut);
  if (layout.fit === 'full') {
    // Static page (website, tweet) under the cam: watches worse than gameplay or a face, so it ranks lower in review.
    db.update(moments).set({ score: moment.score * WEBSITE_PENALTY, signals: { ...(moment.signals ?? {}), website: 1 } }).where(eq(moments.id, momentId)).run();
  }
  const chatFile = join(dir, 'chat.json');
  const chatLines = existsSync(chatFile) ? JSON.parse(readFileSync(chatFile, 'utf8')) as ChatLine[] : [];
  // Chat going wild at the peak shows as a stack; single "he reacts to this" cards stay out of its way.
  const burst = burstChat(chatLines, lead, cut); // chat going wild anywhere in the kept part; most clips get none
  const busy = burst.length ? [burst[0].s, burst[0].e] : null;
  // shortcut: one render for all platforms, masked if any enabled platform wants it; render variants if YouTube reach suffers.
  const censor = settings.clip.censor.platforms.some((p) => settings.platforms[p as keyof typeof settings.platforms]) ? settings.clip.censor.words : undefined;
  // Twitch VOD: the burst is the real Twitch chat (colors, badges, emotes) on a transparent layer; ASS rows only as fallback.
  let twitchChat: { file: string; at: number; dur: number } | null = null;
  const vodId = vodIdOf(source.url);
  if (busy && vodId) {
    const [a, b] = [Math.max(busy[0], lead), Math.min(busy[1], cut)];
    try {
      if (b - a < 2) throw new Error('burst outside trimmed clip');
      await renderTwitchChat({ vodId, from: moment.startSec + a, to: moment.startSec + b, dir, banWords: censor });
      twitchChat = { file: 'twitch-chat.mov', at: a - lead, dur: b - a };
    } catch (e) {
      log.warn(`twitch chat render failed, using caption chat: ${(e as Error).message}`);
    }
  }
  const chat = [...matchChat(t.words, chatLines).filter((c) => !busy || c.e <= busy[0] || c.s >= busy[1]), ...(twitchChat ? [] : burst)]
    .map((c) => ({ ...c, s: Math.max(0, c.s - lead), e: Math.min(c.e, cut) - lead })).filter((c) => c.e > 0.5 && c.s < durationSec);

  const title = await makeTitle(transcript, cfg.name, pickStyle(styleStats(db))); // A/B test, leans to the winner once clear. Hook not burned in: owner wants it as cover/thumbnail instead.
  writeFileSync(join(dir, 'subs.ass'), buildAss({
    words, durationSec, tag: cfg.tag, disclosureSec: settings.clip.disclosureSec, chat,
    // #ad goes in the post text + platform paid-promotion toggle; burned in only if the campaign brief asks for it.
    disclosure: (cfg.campaign?.disclosureInVideo ?? settings.clip.disclosureInVideo) ? disclosure : null,
    style: cfg.captionStyle ?? settings.clip.captionStyle,
    censor,
    // nocam content sits at y~555-1365 on the blurred bg: captions just below it. fullcam: lower, chat card higher.
    captionY: layout.cam ? undefined : layout.scene === 'nocam' ? 1460 : 1300, chatY: layout.cam ? 820 : 400, burstY: layout.cam ? 1010 : 400,
  }));

  // cwd = clip dir + relative forward-slash paths: avoids escaping "E:" inside the ffmpeg filter string.
  const graph = filterGraph(layout, 'subs.ass', fwd(relative(dir, join(paths.rootDir, 'assets', 'fonts'))),
    twitchChat ? { at: twitchChat.at, dur: twitchChat.dur, x: 30, y: layout.cam ? 1000 : 400 } : undefined);
  await runCmd('ffmpeg', ffmpegArgs('src.mp4', 'clip.mp4', graph, hw?.encoder ?? 'libx264', lead,
    duckFilter(quietMusic((music?.musicSec ?? []).map(([a, b]) => [Math.max(0, a - lead), b - lead] as [number, number]).filter(([, b]) => b > 0), words)), durationSec,
    twitchChat?.file ?? null), { cwd: dir });
  for (const f of [src, join(dir, 'twitch-chat.mov'), join(dir, 'twitch-chat.json')]) rmSync(f, { force: true });

  const clip = db.insert(clips).values({ momentId, filePath: join(dir, 'clip.mp4'), durationSec, transcript, compliance: { ...compliance, music },
    title: title?.title, hook: title?.hook, titleStyle: title?.style }).returning().get();
  db.update(moments).set({ status: 'rendered' }).where(eq(moments.id, momentId)).run();
  enqueue(db, 'review.notify', { clipId: clip.id });
  log.info(`clip ${clip.id} rendered (${durationSec.toFixed(0)}s, ${words.length} words)`);
}
