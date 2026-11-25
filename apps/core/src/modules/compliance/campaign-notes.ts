// Campaign facts and warnings in plain words, for the owner (accounts page now, dashboard later).
import type { StreamerConfig } from '../../config.ts';

type Campaign = NonNullable<StreamerConfig['campaign']>;
const HIGH_BAR = 500_000; // views before a pool pays anything: most clippers never reach it
const LOW_RATE = 0.75; // $ per 1K: below this a clip needs huge views to pay off
const SOON_DAYS = 3;
const CR_FEE = 0.1; // Content Rewards keeps 10% of CPM and pool payouts (Creator Terms 5.1, Nov 2026)
const net = (c: Campaign) => (c.platform === 'content_rewards' ? 1 - CR_FEE : 1);
const NAMES: Record<string, string> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', x: 'X' };
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function campaignNotes(c: Campaign, now = new Date()): { facts: string[]; warnings: string[] } {
  const facts: string[] = [], warnings: string[] = [];
  const bar = Number(c.rules?.totalViews ?? 0), perClip = Number(c.rules?.minViews ?? 0);
  if (c.ratePer1k > 0) facts.push(`${usd(c.ratePer1k)} per 1,000 views${c.maxPerClip > 0 ? `, at most ${usd(c.maxPerClip)} per clip` : ''}`);
  else facts.push(`${c.pool ? `${usd(c.pool)} pool` : 'Pool'}, split by views when it ends`);
  if (perClip > 0) facts.push(`Each clip needs ${perClip.toLocaleString('en-US')} views to count`);
  if (bar > 0) facts.push(`Get ${bar.toLocaleString('en-US')} views over all your clips to share the pool`);
  const platforms = c.rules?.platforms;
  if (Array.isArray(platforms)) facts.push(`Counts on: ${platforms.map((p) => NAMES[String(p).toLowerCase()] ?? String(p)).join(', ')}`);
  if (typeof c.rules?.audience === 'string') facts.push(`Audience: ${c.rules.audience}`);
  if (Array.isArray(c.rules?.notes)) facts.push(...c.rules.notes.map(String));
  const end = new Date(c.endsAt);
  facts.push(`Ends ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`);

  const days = Math.ceil((end.getTime() + 86_400_000 - now.getTime()) / 86_400_000); // endsAt counts through that day
  if (days <= 0) warnings.push('Ended: no new clips');
  else if (days <= SOON_DAYS) warnings.push(`Ends in ${days} day${days === 1 ? '' : 's'}: new clips have little time to get views`);
  if (!c.ratePer1k && bar >= HIGH_BAR) warnings.push('High bar: likely little or no pay');
  if (c.ratePer1k > 0 && c.ratePer1k < LOW_RATE) warnings.push('Low rate: likely little pay');
  if (Array.isArray(c.rules?.warn)) warnings.push(...c.rules.warn.map(String));
  return { facts, warnings };
}

/** Rough $ per 1,000 views after the platform fee, to work on the most profitable campaign first. Pool: pool spread over the views bar. */
export function profitScore(c: Campaign): number {
  if (c.ratePer1k > 0) return c.ratePer1k * net(c);
  const bar = Math.max(Number(c.rules?.totalViews ?? 0), 100_000); // shortcut: no bar -> assume 100K views, upgrade once we know real pool shares
  return ((c.pool ?? 0) * net(c) * 1000) / bar;
}

/** Views one clip needs before it earns its first $10 (owner: work on the lowest bar first).
 * Rate: $10 (or the min payout, if higher) at the rate, but never under the views bar. Pool: the bar (share unknown). */
export function viewsToPay(c: Campaign): number {
  const bar = Number(c.rules?.minViews ?? 0);
  if (c.ratePer1k > 0) return Math.max(bar, Math.ceil((Math.max(10 / net(c), Number(c.rules?.minPayout ?? 0)) / c.ratePer1k) * 1000)); // $10 in hand after the fee
  return Math.max(Number(c.rules?.totalViews ?? 0), 100_000); // shortcut: pool share unknown, bar only; upgrade once we see real pool payouts
}
