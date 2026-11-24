import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { paths } from './env.ts';
import type { CaptionStyle } from './modules/editor/subtitles.ts';
import type { ScoringConfig } from './modules/vod-clipper/scoring.ts';

export interface Settings {
  scoring: ScoringConfig;
  clip: { minSec: number; maxSec: number; disclosure: boolean; disclosureText: string; disclosureSec: number; captionStyle?: CaptionStyle; censor: { platforms: string[]; words: string[] } };
  limits: { maxPostsPerAccountPerDay: number };
  retention: { keepSourceDays: number };
  queue: { maxAttempts: number };
  watcher: { pollMinutes: number; maxVodAgeDays: number };
}

export interface StreamerConfig {
  name: string;
  enabled?: boolean;
  platform: 'twitch' | 'kick' | 'youtube';
  channel: string;
  facecam?: { x: number; y: number; w: number; h: number } | null; // fractions of the source frame
  captionStyle?: CaptionStyle; // bold | pop | clean; overrides settings.clip.captionStyle
  tag: string;
  campaign?: { platform: string; ratePer1k: number; maxPerClip: number; endsAt: string; rules?: Record<string, unknown>; disclosure?: boolean; maxSec?: number };
}

const read = (file: string) => parse(readFileSync(join(paths.configDir, file), 'utf8'));

export const loadSettings = (): Settings => read('settings.yaml');

/** Hard rule: only streamers that are enabled AND have a campaign that hasn't ended. */
export function activeStreamers(now = new Date()): StreamerConfig[] {
  const list: StreamerConfig[] = read('streamers.yaml')?.streamers ?? [];
  return list.filter((s) => s.enabled !== false && s.campaign && new Date(s.campaign.endsAt) >= now);
}
