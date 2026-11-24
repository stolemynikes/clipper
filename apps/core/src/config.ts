import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { paths } from './env.ts';
import type { CaptionStyle } from './modules/editor/subtitles.ts';
import type { ScoringConfig } from './modules/vod-clipper/scoring.ts';

export interface Settings {
  scoring: ScoringConfig;
  clip: { minSec: number; maxSec: number; targetSec?: [number, number]; disclosure: boolean; disclosureText: string; disclosureSec: number; disclosureInVideo?: boolean; disclosureInText?: boolean; captionStyle?: CaptionStyle; censor: { platforms: string[]; words: string[] } };
  limits: { maxPostsPerAccountPerDay: number; maxPostsPerAccountPerWeek?: number };
  platforms: Record<'tiktok' | 'youtube' | 'instagram', boolean>;
  publish?: { tiktokPublic?: boolean };
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

export interface StreamerConfig {
  name: string;
  enabled?: boolean;
  platform: 'twitch' | 'kick' | 'youtube';
  channel: string;
  facecam?: { x: number; y: number; w: number; h: number } | null; // fractions of the source frame
  captionStyle?: CaptionStyle; // bold | pop | clean; overrides settings.clip.captionStyle
  tag: string;
  stage?: 'study' | 'clips'; // study: learn from top clips first, no VODs; clips (or unset): make clips
  campaign?: { platform: string; ratePer1k: number; maxPerClip: number; endsAt: string; rules?: Record<string, unknown>; disclosure?: boolean; disclosureInVideo?: boolean; maxSec?: number; budget?: number; budgetLeft?: number; pool?: number; url?: string; whopBountyId?: string }; // url: campaign page to submit on. whopBountyId: bnty_ id, enables auto-submit via the Whop API. budget: total $ for rate campaigns (from the brief). pool: $ split by views
}

const read = (file: string) => parse(readFileSync(join(paths.configDir, file), 'utf8'));

export const loadSettings = (): Settings => read('settings.yaml');

/** Hard rule: only streamers that are enabled AND have a campaign that hasn't ended. */
export function activeStreamers(now = new Date()): StreamerConfig[] {
  const list: StreamerConfig[] = read('streamers.yaml')?.streamers ?? [];
  return list.filter((s) => s.enabled !== false && s.campaign && campaignOpen(s.campaign, now));
}

/** Not ended (endsAt is a date: valid through that day) and budget not nearly gone. */
export function campaignOpen(c: NonNullable<StreamerConfig['campaign']>, now = new Date()): boolean {
  return new Date(c.endsAt).getTime() + 86_400_000 > now.getTime() && !(typeof c.budgetLeft === 'number' && c.budgetLeft < MIN_BUDGET);
}
const MIN_BUDGET = 50; // $ left: below this new clips likely go unpaid

/** Active streamers we make clips for: study stage finished. */
export const clipStreamers = (now = new Date()) => activeStreamers(now).filter((s) => s.stage !== 'study');
