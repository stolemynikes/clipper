// Owner-editable settings.yaml fields for the dashboard. Only keys listed here can be changed, each checked against its range.
// Written through parseDocument so the owner's comments stay. Every module reads loadSettings() per use, so changes apply live.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { paths } from '../env.ts';

type Num = { type: 'number'; min: number; max: number; step?: number; unit?: string };
type Kind = Num | { type: 'bool' } | { type: 'choice'; options: string[] };
export type Field = Kind & { key: string; group: string; label: string; help: string; def?: number | boolean }; // def: code default when the yaml lacks the key

const n = (min: number, max: number, unit?: string, step = 1): Num => ({ type: 'number', min, max, step, unit });
const bool = { type: 'bool' } as const;

export const FIELDS: Field[] = [
  { key: 'limits.maxPostsPerAccountPerDay', group: 'Posting', label: 'Posts per account per day', help: 'More than this a day can look like spam to TikTok and YouTube.', ...n(1, 20) },
  { key: 'limits.maxPostsPerAccountPerWeek', group: 'Posting', label: 'Posts per account per week', help: 'Content Rewards pauses you when too many posts wait for approval.', ...n(1, 100) },
  { key: 'platforms.tiktok', group: 'Posting', label: 'Post to TikTok', help: 'Kept clips go up on TikTok.', ...bool },
  { key: 'platforms.youtube', group: 'Posting', label: 'Post to YouTube Shorts', help: 'Kept clips go up as Shorts.', ...bool },
  { key: 'platforms.instagram', group: 'Posting', label: 'Post to Instagram Reels', help: 'Kept clips go up as Reels.', ...bool },
  { key: 'publish.auto', group: 'Posting', label: 'Post kept clips by themselves', help: 'Off: kept clips wait on Ready to post, where you post or download them yourself.', ...bool },
  { key: 'publish.gapMin', group: 'Posting', label: 'Time between posts', help: 'Posts go up in the evening where the campaign wants viewers (US when the brief names none), this far apart per account.', ...n(15, 480, 'min'), def: 90 },
  { key: 'publish.tiktokPublic', group: 'Posting', label: 'TikTok posts are public', help: 'Only turn on once TikTok approved the app. Off: only you see the posts.', ...bool },

  { key: 'clip.minSec', group: 'Clips', label: 'Shortest clip', help: 'Moments shorter than this are dropped.', ...n(5, 60, 's') },
  { key: 'clip.maxSec', group: 'Clips', label: 'Longest clip', help: "A campaign's own limit still wins when it is shorter.", ...n(10, 180, 's') },
  { key: 'clip.targetSec.0', group: 'Clips', label: 'Aim for at least', help: 'Clips are cut to a length in this range when the moment allows.', ...n(5, 60, 's') },
  { key: 'clip.targetSec.1', group: 'Clips', label: 'Aim for at most', help: 'Short clips got more views in the study of top clips.', ...n(10, 120, 's') },
  { key: 'clip.captionStyle', group: 'Clips', label: 'Caption style', help: 'Look of the words on screen. A streamer can have their own.', type: 'choice', options: ['bold', 'pop', 'clean'] },
  { key: 'clip.disclosure', group: 'Clips', label: '#ad on other campaigns', help: 'Content Rewards clips always get #ad (their rules). This adds it to the rest too.', ...bool },
  { key: 'clip.chatBurst', group: 'Clips', label: 'Show chat when it goes wild', help: 'Off: chat only shows when the streamer reads or answers a message. A chat box takes much of the screen.', ...bool, def: false },
  { key: 'clip.disclosureSec', group: 'Clips', label: '#ad shown for', help: 'How long #ad stays on screen at the start.', ...n(1, 10, 's') },

  { key: 'scoring.perHour', group: 'Finding moments', label: 'Moments per hour of stream', help: 'Longer streams get more clips: at least 5, at most 20 per VOD.', ...n(1, 10), def: 4 },
  { key: 'scoring.weights.chatRate', group: 'Finding moments', label: 'Weight: chat gets busy', help: 'Weekly learning also changes these.', ...n(0, 5, undefined, 0.05) },
  { key: 'scoring.weights.emoteScore', group: 'Finding moments', label: 'Weight: laughing emotes', help: 'Emote spam alone picked worse moments in tests.', ...n(0, 5, undefined, 0.05) },
  { key: 'scoring.weights.viewerClipHits', group: 'Finding moments', label: 'Weight: viewers clipped it', help: 'Clips made by viewers are the strongest sign.', ...n(0, 5, undefined, 0.05) },
  { key: 'scoring.weights.audioPeak', group: 'Finding moments', label: 'Weight: loud moment', help: 'Shouting or a loud game sound.', ...n(0, 5, undefined, 0.05) },

  { key: 'review.autoKeep.enabled', group: 'Review', label: 'Keep sure hits by itself', help: 'Keeps a clip without asking when many viewers clipped it and chat went off.', ...bool },
  { key: 'review.autoKeep.minViewerClips', group: 'Review', label: 'Viewer clips needed', help: 'For keeping by itself.', ...n(1, 50) },
  { key: 'review.autoKeep.minChatRate', group: 'Review', label: 'Chat busier than usual by', help: 'For keeping by itself. 1 is clearly busier, 2 is very busy.', ...n(0, 5, undefined, 0.1) },

  { key: 'watcher.enabled', group: 'Watching streams', label: 'Look for new VODs', help: 'Checks the streamers with a campaign for new streams.', ...bool },
  { key: 'watcher.pollMinutes', group: 'Watching streams', label: 'Check every', help: 'Minutes between checks.', ...n(5, 240, 'min') },
  { key: 'watcher.maxVodAgeDays', group: 'Watching streams', label: 'Skip VODs older than', help: 'When a streamer is new, older streams are ignored.', ...n(1, 30, 'days') },

  { key: 'judge.awayMin', group: 'PC', label: 'Use the graphics card after', help: 'Minutes without mouse or keyboard before heavy work uses the GPU.', ...n(1, 120, 'min') },
  { key: 'retention.keepSourceDays', group: 'PC', label: 'Keep downloaded streams', help: 'Days before the full stream is deleted. Clips stay.', ...n(0, 30, 'days') },
  { key: 'queue.maxAttempts', group: 'PC', label: 'Tries per step', help: 'A failed step is retried this often before you get an alert.', ...n(1, 10) },
];

const file = () => join(paths.configDir, 'settings.yaml');
const pathOf = (key: string) => key.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p));

/** Fields with their current values. */
export function getSettings(text = readFileSync(file(), 'utf8')) {
  const doc = parseDocument(text);
  return FIELDS.map((f) => ({ ...f, value: doc.getIn(pathOf(f.key)) ?? f.def ?? null }));
}

/** Checks and parses a dashboard value; throws with a plain message. */
export function parseValue(key: string, raw: string): number | boolean | string {
  const f = FIELDS.find((x) => x.key === key);
  if (!f) throw new Error('Unknown setting');
  if (f.type === 'bool') { if (raw !== 'true' && raw !== 'false') throw new Error('Must be on or off'); return raw === 'true'; }
  if (f.type === 'choice') { if (!f.options.includes(raw)) throw new Error(`Pick one of ${f.options.join(', ')}`); return raw; }
  const v = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(v) || v < f.min || v > f.max) throw new Error(`Use a number from ${f.min} to ${f.max}`);
  return f.step && f.step < 1 ? Number((Math.round(v / f.step) * f.step).toFixed(2)) : Math.round(v);
}

/** Sets one field and returns the new yaml (comments kept). Keeps min <= max for the length pairs. */
export function applySetting(text: string, key: string, raw: string): string {
  const v = parseValue(key, raw), doc = parseDocument(text);
  const pairs: [string, string][] = [['clip.minSec', 'clip.maxSec'], ['clip.targetSec.0', 'clip.targetSec.1']];
  for (const [lo, hi] of pairs) {
    if (key === lo && v as number > Number(doc.getIn(pathOf(hi)))) throw new Error('Must not be more than the longest');
    if (key === hi && v as number < Number(doc.getIn(pathOf(lo)))) throw new Error('Must not be less than the shortest');
  }
  doc.setIn(pathOf(key), v);
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 }); // same layout as the hand-written file
}

export const saveSetting = (key: string, raw: string) => writeFileSync(file(), applySetting(readFileSync(file(), 'utf8'), key, raw));
