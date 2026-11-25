// Checks a clip against the campaign brief and the hard rules (CLAUDE.md). A clip with a block never reaches review.
// Reasons are plain words: they show up in the review page and logs for non-tech users.

/** #ad needed? The campaign's own setting wins; Content Rewards' FTC Terms (3.2, contentrewards.com/ftc-compliance)
 *  make every CR campaign post a paid endorsement, so CR campaigns need it even when the brief is silent. */
export const needsDisclosure = (c: { platform?: string; disclosure?: boolean } | null | undefined, fallback: boolean) =>
  c?.disclosure ?? (c?.platform === 'content_rewards' || fallback);

export interface Music { musicRatio: number; vocalRatio: number }

export interface ComplianceInput {
  campaign?: { endsAt: string; rules?: Record<string, unknown> } | null;
  tag?: string | null;
  durationSec: number;
  limits: { minSec: number; maxSec: number };
  disclosureRequired: boolean;
  disclosure: string | null;
  music?: Music | null;
  transcript: string;
  sourceDate?: Date | null; // when the stream aired
  budget?: { used: number; total: number } | null; // estimated payout so far vs the campaign budget
  duplicateOf?: number | null; // earlier clip with the same speech
  now?: Date;
}

export interface Compliance { ok: boolean; blocks: string[]; warnings: string[] }

// Whole words only: gaming slang like "inventory slots" or "I'll gamble" must not block.
const GAMBLING = /\b(casino|roulette|blackjack|stake\.com|stake code|sportsbook|slot machine|bet365|gamdom|roobet|rollbit|crash gambling|gambling site)\b/i;
export const MUSIC_BLOCK = 0.5; // over half the clip is someone else's music
export const VOCAL_BLOCK = 0.15; // sung/rapped song = licensed track
export const MUSIC_WARN = 0.15;

export function checkClip(i: ComplianceInput): Compliance {
  const now = i.now ?? new Date();
  const blocks: string[] = [];
  const warnings: string[] = [];

  if (!i.campaign) blocks.push('No active campaign for this streamer');
  else if (new Date(i.campaign.endsAt).getTime() + 86_400_000 <= now.getTime()) blocks.push('The campaign has ended'); // endsAt is a date: valid through that day

  const from = i.campaign?.rules?.sourceFrom;
  if (from && i.sourceDate && i.sourceDate < new Date(String(from))) blocks.push(`Stream is older than the campaign allows (from ${String(from)})`);

  if (i.budget && i.budget.total > 0 && i.budget.used >= i.budget.total) blocks.push('The campaign budget is used up');
  if (i.duplicateOf) blocks.push(`Same moment as clip ${i.duplicateOf}`);

  if (i.durationSec < i.limits.minSec) blocks.push(`Too short (${Math.round(i.durationSec)}s, needs ${i.limits.minSec}s)`);
  if (i.durationSec > i.limits.maxSec + 0.5) blocks.push(`Too long (${Math.round(i.durationSec)}s, max ${i.limits.maxSec}s)`);

  if (i.disclosureRequired && !i.disclosure) blocks.push('Missing the #ad disclosure');
  if (!i.tag) blocks.push('Missing the streamer tag');

  const bet = GAMBLING.exec(i.transcript);
  if (bet) blocks.push(`Gambling content ("${bet[0]}")`);

  if (i.music) {
    if (i.music.vocalRatio >= VOCAL_BLOCK) blocks.push('A song with vocals plays in the background');
    else if (i.music.musicRatio >= MUSIC_BLOCK) blocks.push('Mostly music from someone else');
    else if (i.music.musicRatio >= MUSIC_WARN) warnings.push('Some background music (turned down where nobody talks)');
  } else warnings.push('Music check did not run');

  // Audience rules (e.g. "40% of views from US/UK/CA/AU") can't be measured yet: remind the reviewer.
  const audience = i.campaign?.rules?.audience;
  if (typeof audience === 'string' && audience) warnings.push(`Campaign wants this audience: ${audience}`);
  return { ok: blocks.length === 0, blocks, warnings };
}
