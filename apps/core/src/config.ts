import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { paths } from './env.ts';
import type { CaptionStyle } from './modules/editor/subtitles.ts';
import type { ScoringConfig } from './modules/vod-clipper/scoring.ts';

export interface Settings {
  scoring: ScoringConfig;
  clip: { minSec: number; maxSec: number; targetSec?: [number, number]; disclosure: boolean; disclosureText: string; disclosureSec: number; disclosureInVideo?: boolean; disclosureInText?: boolean; captionStyle?: CaptionStyle; chatBurst?: boolean; censor: { platforms: string[]; words: string[] } };
  limits: { maxPostsPerAccountPerDay: number; maxPostsPerAccountPerWeek?: number };
  platforms: Record<'tiktok' | 'youtube' | 'instagram', boolean>;
  publish?: { tiktokPublic?: boolean; auto?: boolean; gapMin?: number };
  titles?: { model: string };
  retention: { keepSourceDays: number };
  queue: { maxAttempts: number };
  watcher: { enabled?: boolean; pollMinutes: number; maxVodAgeDays: number };
  study?: { extra?: string[] };
  review?: { autoKeep?: AutoKeep };
  judge?: { awayMin: number };
  scout?: { enabled?: boolean };
}

export interface AutoKeep { enabled: boolean; minViewerClips: number; minChatRate: number }

/** exact: the measured webcam border, used as is (edge snap is skipped; it found door frames inside the room). */
export interface FacecamBox { x: number; y: number; w: number; h: number; exact?: boolean }

export type Genre = 'podcast' | 'music' | 'show' | 'product';
/** Per kind of footage campaign: default layout, caption look (null = no captions) and what makes a good clip, for the judge.
 *  A campaign's own layout or captionStyle wins. */
export const GENRES: Record<Genre, { layout: 'face' | 'whole'; captions: CaptionStyle | null; focus: string }> = {
  podcast: { layout: 'face', captions: 'bold', focus: 'a strong statement, hot take, story payoff or funny line that grabs in the first 2 seconds' },
  music: { layout: 'whole', captions: null, focus: 'the chorus, the highest-energy part of the performance or a big crowd moment; the song must be heard' },
  show: { layout: 'whole', captions: 'clean', focus: 'a reaction, reveal, twist or funny line that works without knowing the rest' },
  product: { layout: 'whole', captions: 'clean', focus: 'the moment the product is clearly seen or used, with a clear result' },
};
export const FOOTAGE_FOCUS = 'one clear moment that works on its own, without knowing the rest of the video';

export interface StreamerConfig {
  name: string;
  enabled?: boolean;
  platform: 'twitch' | 'kick' | 'youtube' | 'footage';
  channel: string; // footage: same as name
  footage?: string[]; // footage campaigns: the brand's Drive or Dropbox folder links (only videos in them are used)
  genre?: Genre; // footage: what kind of video (podcast, music, show, product); sets the default layout, captions and what the judge looks for
  layout?: 'face' | 'whole'; // footage: face = follow the speaker (podcast), whole = whole frame on blur (show, product). Unset: face when one is found
  facecam?: FacecamBox | FacecamBox[] | null; // fractions of the source frame; list = one box per scene
  captionStyle?: CaptionStyle; // bold | pop | clean; overrides settings.clip.captionStyle
  tag: string;
  stage?: 'study' | 'clips'; // study: learn from top clips first, no VODs; clips (or unset): make clips
  campaign?: { platform: string; ratePer1k: number; maxPerClip: number; endsAt: string; rules?: Record<string, unknown>; disclosure?: boolean; disclosureInVideo?: boolean; maxSec?: number; budget?: number; budgetLeft?: number; closed?: boolean; pool?: number; url?: string; whopBountyId?: string; rulePreset?: string; judgeRules?: string[] }; // rulePreset/judgeRules: layout checks for the judge (config/judge-rules.yaml). url: campaign page to submit on. whopBountyId: bnty_ id, enables auto-submit via the Whop API. closed: CR submissions closed (scout sync). budget: total $ for rate campaigns (from the brief). pool: $ split by views
}

const read = (file: string) => parse(readFileSync(join(paths.configDir, file), 'utf8'));

export const loadSettings = (): Settings => read('settings.yaml');

/** Hard rule: only streamers switched on by the owner (enabled: true, opt-in) AND have a campaign that hasn't ended. */
export function activeStreamers(now = new Date()): StreamerConfig[] {
  const list: StreamerConfig[] = read('streamers.yaml')?.streamers ?? [];
  return list.filter((s) => s.enabled === true && s.campaign && campaignOpen(s.campaign, now));
}

/** Not ended (endsAt is a date: valid through that day) and budget not nearly gone. */
export function campaignOpen(c: NonNullable<StreamerConfig['campaign']>, now = new Date()): boolean {
  return !c.closed && new Date(c.endsAt).getTime() + 86_400_000 > now.getTime() && !(typeof c.budgetLeft === 'number' && c.budgetLeft < MIN_BUDGET);
}
const MIN_BUDGET = 50; // $ left: below this new clips likely go unpaid

/** Active streamers we make clips for: study stage finished. */
export const clipStreamers = (now = new Date()) => activeStreamers(now).filter((s) => s.stage !== 'study');
