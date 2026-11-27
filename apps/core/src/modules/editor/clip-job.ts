import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { eq } from 'drizzle-orm';
import { GENRES, isFootage, loadSettings, type StreamerConfig } from '../../config.ts';
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
import { CHAT_BOX, CHAT_LAG, renderTwitchChat, vodIdOf } from './twitch-chat.ts';
import { checkClip, isSteadyMusic, needsDisclosure, type Music } from '../compliance/compliance.ts';
import { findDuplicate } from '../compliance/duplicate.ts';
import { accountStats } from '../../review/setup.ts';
import { captionSpot, chatSpot, duckFilter, faceTrouble, ffmpegArgs, filterGraph, type Layout, quietMusic, type Rect, stackTop } from './render.ts';
import { buildAss, type Word } from './subtitles.ts';
import { makeTitle } from '../publisher/titles.ts';
import { pickStyle, styleStats } from '../learner/title-style.ts';
import { transcribe } from './whisper.ts';
import { activeProposals, proposals, type Change, isLength, kindFor, tweaks } from '../practice/proposals.ts';
import { keepWindow, tried } from '../practice/practice.ts';

const log = logger('editor');
const fwd = (p: string) => p.replaceAll('\\', '/');
const WEBSITE_PENALTY = 0.5;
const CHAT_HOLD = 10; // s the Twitch chat box stays at least
const SILENT_DB = -50; // peak below this = mic off / muted stream start: nothing worth clipping

/** Cam box + content crop per clip (cams differ per streamer and per scene), measured on the kept part [start, end]. */
async function detectLayout(src: string, hint: StreamerConfig["facecam"], start: number, end: number): Promise<Layout> {
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

/** Sets word.sp (speaker) from workers/diarize.py on [start, end]; words are relative to start. Never blocks the clip. */
async function tagSpeakers(src: string, start: number, end: number, words: Word[]): Promise<void> {
  try {
    const { segments } = JSON.parse(await runCmd(paths.pythonBin, [join(paths.rootDir, 'workers', 'diarize.py'), JSON.stringify({ input: src, start, end })])) as
      { segments: { start: number; end: number; speaker: number }[] };
    for (const w of words) {
      const overlap = (g: { start: number; end: number }) => Math.min(w.e, g.end) - Math.max(w.s, g.start);
      const best = segments.reduce<typeof segments[number] | null>((b, g) => (overlap(g) > (b ? overlap(b) : 0) ? g : b), null);
      if (best) w.sp = best.speaker;
    }
  } catch (e) { log.warn(`diarize failed, one caption colour: ${(e as Error).message}`); }
}

/** Face boxes per frame in a rendered clip (fractions of the 9:16 frame); [] when the check cannot run (never blocks). */
async function renderedFaces(file: string): Promise<Rect[][]> {
  try {
    const out = await runCmd(paths.pythonBin, [join(paths.rootDir, 'workers', 'face_track.py'),
      JSON.stringify({ check: true, input: file, model: join(paths.rootDir, 'assets', 'models', 'blaze_face_short_range.tflite') })]);
    return (JSON.parse(out) as { frames: Rect[][] }).frames;
  } catch (e) {
    log.warn(`face check failed: ${(e as Error).message}`);
    return [];
  }
}

const WHOLE: Layout = { scene: 'nocam', cam: null, content: { x: 0, y: 0, w: 1, h: 1 } };

/** Footage is not a stream: no facecam over gameplay. A podcast follows the speaker's face (fullcam crop);
 *  a show, film or product video shows the whole frame on blur. cfg.layout forces one. */
export async function footageLayout(src: string, cfg: StreamerConfig, start: number, end: number): Promise<Layout> {
  const want = cfg.layout ?? (cfg.genre && GENRES[cfg.genre].layout);
  if (want === 'whole') return WHOLE;
  const l = await detectLayout(src, null, start, end);
  if ((l.faces ?? 0) >= 2) return l; // two people: face_track already gives a crop around all faces (nocam on blur)
  return l.scene === 'fullcam' || (want === 'face' && l.content) ? { ...l, scene: 'fullcam', cam: null, fit: undefined } : WHOLE;
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

/** Downloads only [from, to] of a VOD. Twitch goes through TwitchDownloaderCLI: it picks segments from the playlist, while
 *  ffmpeg's -ss trusts MPEG-TS timestamps, which wrap at 2^33/90 kHz (26.5 h), so ffmpeg searched forever past that point. */
async function downloadSection(url: string, from: number, to: number, final: string) {
  const out = final.replace(/\.mp4$/, '.part.mp4'); // a killed download leaves only the .part file, never a broken src.mp4
  await fetchSection(url, from, to, out);
  if (!existsSync(out) || statSync(out).size === 0) { rmSync(out, { force: true }); throw new Error('section download left no video'); }
  renameSync(out, final);
}

export async function fetchSection(url: string, from: number, to: number, out: string) {
  // Footage: a local file. Stream copy, so the start snaps to the keyframe before `from`; the trim then cuts on sentences anyway.
  if (!/^https?:/i.test(url)) return void await runCmd('ffmpeg', ['-y', '-v', 'error', '-ss', String(from), '-i', url, '-t', String(to - from), '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', out]);
  const vodId = vodIdOf(url), timeoutMs = 15 * 60_000; // a stalled download fails the job instead of holding the queue
  if (vodId) {
    try {
      await runCmd(join(paths.toolsDir, 'TwitchDownloaderCLI.exe'), ['videodownload', '--id', vodId, '-b', `${from}s`, '-e', `${to}s`, '-q', '1080p60', '-o', out,
        '--collision', 'Overwrite', '--banner', 'false', '--log-level', 'Error', '--temp-path', process.env.TEMP ?? dirname(out)], { timeoutMs });
      return;
    } catch (e) { log.warn('TwitchDownloader failed, trying yt-dlp', { error: String(e).slice(0, 300) }); rmSync(out, { force: true }); }
  }
  await runCmd('yt-dlp', ['-q', '--no-warnings', '--force-overwrites', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--download-sections', `*${from}-${to}`, '--merge-output-format', 'mp4', '-o', out, url], { timeoutMs });
}

/** retest: practice moment rendered before, raw window kept; encode only the proposals it has not tried.
 *  redo: render a reviewed moment again from scratch into its existing clip row (lost or badly framed clip.mp4). */
export async function renderClip(db: Db, { momentId, practice, retest, proof, redo }: { momentId: number; practice?: boolean; retest?: boolean; proof?: string[]; redo?: boolean }) {
  const moment = db.select().from(moments).where(eq(moments.id, momentId)).get();
  if (!moment) throw new Error(`moment ${momentId} not found`);
  const prev = db.select().from(clips).where(eq(clips.momentId, momentId)).get(), old = redo ? undefined : prev;
  if (old && !(retest && practice) && !proof) return log.info(`moment ${momentId} already rendered`);
  const { source, cfg } = sourceContext(db, moment.sourceId);
  const settings = loadSettings();
  const hw = readHardwareConfig();
  const dir = join(paths.dataDir, 'clips', String(momentId));
  mkdirSync(dir, { recursive: true });
  if (!proof) db.update(moments).set({ status: 'rendering' }).where(eq(moments.id, momentId)).run();

  // Only the moment itself is downloaded, never the whole VOD.
  const src = join(dir, 'src.mp4'); // already there for a re-test or a study clip
  const had = existsSync(src);
  if (!existsSync(src) || statSync(src).size === 0) await downloadSection(source.url, moment.startSec, moment.endSec, src);

  // a broken download fails here every retry; dropping it makes the next attempt download it again
  const t = await transcribe({ input: src, model: hw?.whisperModelVod ?? 'medium', language: null }).catch((e) => { rmSync(src, { force: true }); throw e; });
  const { peakDb } = t;
  // Keep only build-up + peak + reaction: start on a sentence, end after the reaction sentence.
  const sc = settings.scoring;
  const maxSec = cfg.campaign?.maxSec ?? settings.clip.maxSec;
  const peakRel = (moment.signals?.peakAt ?? moment.endSec - sc.windowSec - (sc.tailSec ?? 0)) - moment.startSec;
  const kind = kindFor(cfg), live = tweaks(undefined, kind); // only owner-approved proposals change live clips (practice-plan: freeze the automatic tweaks)
  const target = settings.clip.targetSec ?? [settings.clip.minSec, maxSec];
  const trimFor = (ch: Change) => trimWindow({ words: t.words, durationSec: moment.endSec - moment.startSec, peakRel, windowSec: sc.windowSec,
    tailSec: sc.tailSec ?? 0, targetSec: [target[0], Math.max(target[0], ch.maxLen ?? target[1])], minSec: settings.clip.minSec, maxSec, leadSec: ch.leadSec, deadAirSec: ch.deadAirSec });
  const { start: lead, end: cut } = trimFor(live);
  const words = t.words.filter((w) => w.s >= lead && w.s < cut).map((w) => ({ ...w, s: w.s - lead, e: Math.min(w.e, cut) - lead }));
  if (proof && ((peakDb ?? 0) < SILENT_DB)) return log.warn(`proof ${momentId}: silent`);
  if ((peakDb ?? 0) < SILENT_DB) {
    rmSync(src, { force: true });
    db.update(moments).set({ status: 'skipped' }).where(eq(moments.id, momentId)).run();
    return log.warn(`moment ${momentId} skipped: silent audio (${peakDb} dB)`);
  }

  const durationSec = cut - lead;
  const disclosure = needsDisclosure(cfg.campaign, settings.clip.disclosure) ? settings.clip.disclosureText : null;
  const transcript = words.map((w) => w.w).join(' ');
  const music = await detectMusic(src);
  // Kept on the moment (blocked ones too) so later moments of this stream can tell game music from a song.
  if (music && !proof) { moment.signals = { ...(moment.signals ?? {}), musicRatio: music.musicRatio }; db.update(moments).set({ signals: moment.signals }).where(eq(moments.id, momentId)).run(); }
  // shortcut: moments blocked before 3 others were measured stay skipped; re-queue them if game-music streams lose clips
  const steadyMusic = isSteadyMusic(db.select({ id: moments.id, s: moments.signals }).from(moments).where(eq(moments.sourceId, moment.sourceId)).all()
    .filter((m) => m.id !== momentId && typeof m.s?.musicRatio === 'number').map((m) => m.s!.musicRatio));
  const used = accountStats(db).filter((a) => a.streamer === cfg.name).reduce((n, a) => n + a.earned, 0);
  const compliance = checkClip({
    campaign: cfg.campaign, tag: cfg.tag, durationSec, limits: { minSec: settings.clip.minSec, maxSec: cfg.campaign?.maxSec ?? settings.clip.maxSec },
    disclosureRequired: needsDisclosure(cfg.campaign, settings.clip.disclosure), disclosure, music, ownAudio: isFootage(cfg), steadyMusic,
    transcript, duplicateOf: source.streamerId && !prev && !practice ? findDuplicate(db, source.streamerId, transcript) : null,
    budget: cfg.campaign?.budget ? { used, total: cfg.campaign.budget } : null,
    sourceDate: null, // shortcut: VOD air date not stored yet, add it in the watcher when a brief sets sourceFrom strictly
  });
  if (proof && !compliance.ok) return log.warn(`proof ${momentId}: blocked ${compliance.blocks.join('; ')}`);
  if (!compliance.ok) {
    rmSync(src, { force: true });
    db.update(moments).set({ status: 'skipped' }).where(eq(moments.id, momentId)).run();
    return log.warn(`moment ${momentId} blocked: ${compliance.blocks.join('; ')}`);
  }

  // Practice: every testing proposal of this kind not tried on this window yet (tried.txt lets a later proposal re-test it).
  const was = practice ? tried(dir) : [], act = proof ? proposals().filter((p) => proof.includes(p.id)) : practice ? activeProposals(6, kind) : [];
  const props = act.filter((p) => !was.includes(p.id) && (!p.change.gameCrop || p.change.gameCrop[cfg.name]));
  if (practice && !proof) writeFileSync(join(dir, 'tried.txt'), [...new Set([...was, ...act.map((p) => p.id)])].join('\n'));
  if (old && !props.length) { if (!proof) keepWindow(dir); // proof never deletes: a review clip's dir has no tried.txt
    return log.info(`moment ${momentId}: nothing new to re-test`); }

  let layout = isFootage(cfg) ? await footageLayout(src, cfg, lead, cut) : await detectLayout(src, cfg.facecam ?? null, lead, cut);
  // 2+ people on screen: caption colour per speaker, only when live or a tested proposal wants it (owner: test first).
  if ((layout.faces ?? 0) >= 2 && (live.speakerColors || props.some((p) => p.change.speakerColors))) await tagSpeakers(src, lead, cut, words);
  if (proof) log.info(`proof layout: ${JSON.stringify(layout)}; music spans: ${JSON.stringify(music?.musicSec ?? [])}`); // why a proposal does or does not change the output
  if (layout.fit === 'full' && !proof) {
    // Static page (website, tweet) under the cam: watches worse than gameplay or a face, so it ranks lower in review.
    db.update(moments).set({ score: moment.score * WEBSITE_PENALTY, signals: { ...(moment.signals ?? {}), website: 1 } }).where(eq(moments.id, momentId)).run();
  }
  const chatFile = join(dir, 'chat.json');
  const chatLines = existsSync(chatFile) ? JSON.parse(readFileSync(chatFile, 'utf8')) as ChatLine[] : [];
  // Chat going wild at the peak shows as a stack; single "he reacts to this" cards stay out of its way.
  // Off by default: a chat box eats the screen and top clips rarely show one; reacted-to messages (matchChat) still show.
  const burstOn = (ch: Change) => ch.chatBurst ?? settings.clip.chatBurst ?? false; // a proposal can test it either way
  const burst = burstOn(live) || props.some((p) => burstOn({ ...live, ...p.change })) ? burstChat(chatLines, lead, cut) : []; // chat going wild anywhere in the kept part; most clips get none
  const busy = burst.length ? [burst[0].s, burst[0].e] : null;
  // shortcut: one render for all platforms, masked if any enabled platform wants it; render variants if YouTube reach suffers.
  const censor = settings.clip.censor.platforms.some((p) => settings.platforms[p as keyof typeof settings.platforms]) ? settings.clip.censor.words : undefined;
  // Twitch VOD: the burst is the real Twitch chat (colors, badges, emotes) on a transparent layer; ASS rows only as fallback.
  let twitchChat: { file: string; at: number; dur: number } | null = null;
  const vodId = vodIdOf(source.url);
  if (busy && vodId) {
    // Chat stays at least CHAT_HOLD s (a 5s burst felt cut short); shown CHAT_LAG earlier, so it may run up to cut + CHAT_LAG.
    const [a, b] = [Math.max(busy[0], lead), Math.min(Math.max(busy[1], busy[0] + CHAT_HOLD), cut + CHAT_LAG)];
    try {
      if (b - a < 2) throw new Error('burst outside trimmed clip');
      const mov = await renderTwitchChat({ vodId, from: moment.startSec + a, to: moment.startSec + b, dir, banWords: censor });
      const at = Math.max(0, a - lead - CHAT_LAG);
      // Fade-out needs the real end: the render can be shorter than asked, and it must end before the clip does.
      const real = Number(await runCmd('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mov])) || b - a;
      twitchChat = { file: 'twitch-chat.mov', at, dur: Math.min(b - a, real, durationSec - at) };
    } catch (e) {
      log.warn(`twitch chat render failed, using caption chat: ${(e as Error).message}`);
    }
  }
  const chat = [...matchChat(t.words, chatLines).filter((c) => !busy || c.e <= busy[0] || c.s >= busy[1]), ...(twitchChat ? [] : burst)]
    .map((c) => ({ ...c, s: Math.max(0, c.s - lead), e: Math.min(c.e, cut) - lead })).filter((c) => c.e > 0.5 && c.s < durationSec);
  const calm = matchChat(t.words, chatLines).map((c) => ({ ...c, s: Math.max(0, c.s - lead), e: Math.min(c.e, cut) - lead })).filter((c) => c.e > 0.5 && c.s < durationSec); // burst off: only reacted-to cards

  const genre = isFootage(cfg) && cfg.genre ? GENRES[cfg.genre] : undefined;
  const title = old || proof ? null : await makeTitle(transcript, cfg.name, pickStyle(styleStats(db)), kind); // A/B test, leans to the winner once clear. Hook not burned in: owner wants it as cover/thumbnail instead.
  const quiet = quietMusic((isFootage(cfg) ? [] : music?.musicSec ?? []).map(([a, b]) => [Math.max(0, a - lead), b - lead] as [number, number]).filter(([, b]) => b > 0), words);
  // nocam content sits at y~555-1365 on the blurred bg: captions just below it. fullcam: off the face. Shift capped above the app buttons.
  const capY = (ch: Change, l = layout) => Math.min(1560, (layout.cam ? 900 + stackTop(layout) : layout.scene === 'nocam' ? 1460 : captionSpot(l)) + (ch.captionShift ?? 0));
  const encode = async (out: string, ch: Change) => {
    const own = ch.gameCrop?.[cfg.name]; // only the plain cam scene: stack/full layouts already pick their own content
    const lay: typeof layout = own && layout.cam && !layout.fit ? { ...layout, content: own, ...(own.fit && { fit: own.fit }) } : layout;
    const dy = stackTop(lay), chatTop = 1920 - dy - CHAT_BOX.h - 16; // a whole-frame proposal moves cam + game into a centered block
    const subs = out.replace('.mp4', '.ass');
    const captionY = capY(ch), spot = chatSpot(lay, captionY); // fullcam: a free spot beside the head, null = no box
    writeFileSync(join(dir, subs), buildAss({
      words: !cfg.captionStyle && genre?.captions === null ? [] : ch.speakerColors ? words : words.map(({ sp: _, ...w }) => w), durationSec, tag: cfg.tag, // music: the song speaks, no lyrics on screen
      disclosureSec: settings.clip.disclosureSec, chat: burstOn(ch) ? chat : calm,
      // #ad goes in the post text + platform paid-promotion toggle; burned in only if the campaign brief asks for it.
      disclosure: (cfg.campaign?.disclosureInVideo ?? settings.clip.disclosureInVideo) ? disclosure : null,
      style: ch.captionStyle ?? cfg.captionStyle ?? genre?.captions ?? settings.clip.captionStyle,
      wordsPerChunk: ch.wordsPerChunk, // style default unless an approved proposal sets it
      censor,
      // stack: everything moves down with the centered block; chat sits on the game's bottom edge. Shift capped above the app buttons.
      captionY, chatY: layout.cam ? 820 + dy : spot ?? 150, burstY: layout.cam ? (dy ? chatTop : 1600) : spot ?? 150,
    }));
    // cwd = clip dir + relative forward-slash paths: avoids escaping "E:" inside the ffmpeg filter string.
    const graph = filterGraph(lay, subs, fwd(relative(dir, join(paths.rootDir, 'assets', 'fonts'))),
      twitchChat && burstOn(ch) && (layout.cam || spot != null) ? { at: twitchChat.at, dur: twitchChat.dur, x: 16, y: layout.cam ? (dy ? chatTop : 1564) : spot! } : undefined);
    const duck = duckFilter(quiet, ch.duckVol);
    await runCmd('ffmpeg', ffmpegArgs('src.mp4', out, graph, hw?.encoder ?? 'libx264', lead, duck, durationSec,
      burstOn(ch) && (layout.cam || spot != null) ? twitchChat?.file ?? null : null, ch.lufs), { cwd: dir });
  };
  const pre = proof ? 'proof-' : 'clip-'; // proof never overwrites a real clip.mp4
  // Would be a byte copy of live: no plain cam scene for a crop, no music-only part to duck.
  const run = props.filter((p) => {
    const why = p.change.gameCrop && (!layout.cam || layout.fit) ? 'crop not used on this layout' : p.change.duckVol !== undefined && !duckFilter(quiet) ? 'no music without speech here' : p.change.chatBurst !== undefined && !burst.length ? 'chat never goes wild here' : p.change.speakerColors && new Set(words.map((w) => w.sp).filter((x) => x != null)).size < 2 ? 'one speaker here' : null;
    if (why) log.info(`${p.id}: ${why}, skipped`);
    return !why;
  });
  if (old && !run.length) { if (!proof) keepWindow(dir); return log.info(`moment ${momentId}: nothing here the proposals can change`); }
  const liveOut = proof ? 'proof-live.mp4' : 'clip.mp4';
  await encode(liveOut, live);
  // fullcam: check the render itself. A cut-off or off-center face gets one re-crop on the measured face; the measured face
  // also moves the chat box off the head. Podcasts (2+ faces) are exempt: one face is off center there on purpose.
  for (let i = 0; layout.scene === 'fullcam' && (layout.faces ?? 1) < 2 && layout.content; i++) {
    const frames = await renderedFaces(join(dir, liveOut)), why = faceTrouble(frames), c: Rect = layout.content;
    const seen = frames.map((fs) => fs.filter((f) => f.w >= 0.2).sort((a, b) => b.w - a.w)[0]).filter((f): f is Rect => !!f);
    const med = (k: keyof Rect) => seen.map((f) => f[k]).sort((a, b) => a - b)[Math.floor(seen.length / 2)];
    const face = seen.length ? { x: c.x + med('x') * c.w, y: c.y + med('y') * c.h, w: med('w') * c.w, h: med('h') * c.h } : layout.face;
    const next: Layout = { ...layout, face, content: why && seen.length ? { ...c, x: Math.min(Math.max(face!.x + face!.w / 2 - c.w / 2, 0), 1 - c.w) } : c };
    const moved = capY(live, next) !== capY(live) || chatSpot(next, capY(live, next)) !== chatSpot(layout, capY(live));
    if (i || (!why || !seen.length) && !moved) {
      if (!why) break;
      if (proof) { log.warn(`proof ${momentId}: ${why}`); break; }
      rmSync(src, { force: true });
      db.update(moments).set({ status: 'skipped' }).where(eq(moments.id, momentId)).run();
      return log.warn(`moment ${momentId} skipped: ${why}`);
    }
    log.info(`reframe: ${why ?? 'captions/chat box moved off the face'}`);
    layout = next;
    await encode(liveOut, live);
  }
  // Practice A/B: same moment again with the proposal on top of the live template; the judge compares the two.
  // Every testing proposal gets its own encode of this one download + transcript: several proposals per night instead of one.
  for (const p of run) {
    if (!isLength(p.change)) { await encode(`${pre}${p.id}.mp4`, { ...live, ...p.change }); continue; }
    // Length: only the cut moves, judged on the transcripts, so no encode needed.
    const v = trimFor({ ...live, ...p.change });
    const text = t.words.filter((w) => w.s >= v.start && w.s < v.end).map((w) => w.w).join(' ');
    writeFileSync(join(dir, `${pre}${p.id}.json`), JSON.stringify({ sec: v.end - v.start, text }));
  }
  if (proof) for (const f of [...(had ? [] : [src]), join(dir, 'twitch-chat.mov'), join(dir, 'twitch-chat.json')]) rmSync(f, { force: true });
  if (proof) return log.info(`proof ${momentId}: ${run.map((p) => p.id).join(', ')} rendered as proof-*.mp4`); // no DB change, no judge
  if (run.length) writeFileSync(join(dir, 'proposals.txt'), run.map((p) => p.id).join('\n'));
  for (const f of [...(practice ? [] : [src]), join(dir, 'twitch-chat.mov'), join(dir, 'twitch-chat.json')]) rmSync(f, { force: true });

  if (old) db.update(clips).set({ durationSec, transcript, compliance: { ...compliance, music } }).where(eq(clips.id, old.id)).run();
  const row = { momentId, filePath: join(dir, 'clip.mp4'), durationSec, transcript, compliance: { ...compliance, music }, title: title?.title, hook: title?.hook, titleStyle: title?.style };
  const clip = old ?? (prev ? db.update(clips).set(row).where(eq(clips.id, prev.id)).returning().get()
    : db.insert(clips).values({ ...row, ...(practice && { status: 'practice' as const }) }).returning().get());
  db.update(moments).set({ status: 'rendered' }).where(eq(moments.id, momentId)).run();
  enqueue(db, practice ? 'practice.judge' : 'clip.judge', { clipId: clip.id, ...(old && { retest: true }) }); // judge then asks for review (not for practice)
  log.info(`clip ${clip.id} rendered (${durationSec.toFixed(0)}s, ${words.length} words)`);
}
