// Campaign facts and warnings in plain words, for the owner (accounts page now, dashboard later).
import type { StreamerConfig } from '../../config.ts';

type Campaign = NonNullable<StreamerConfig['campaign']>;
const HIGH_BAR = 500_000; // views before a pool pays anything: most clippers never reach it
const LOW_RATE = 0.75; // $ per 1K: below this a clip needs huge views to pay off
const SOON_DAYS = 3;
const NAMES: Record<string, string> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', x: 'X' };
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function campaignNotes(c: Campaign, now = new Date()): { facts: string[]; warnings: string[] } {
  const facts: string[] = [], warnings: string[] = [];
  const bar = Number(c.rules?.minViews ?? 0);
  if (c.ratePer1k > 0) facts.push(`${usd(c.ratePer1k)} per 1,000 views${c.maxPerClip > 0 ? `, at most ${usd(c.maxPerClip)} per clip` : ''}`);
  else facts.push(`${c.pool ? `${usd(c.pool)} pool` : 'Pool'}, split by views when it ends`);
  if (bar > 0) facts.push(`Pays only after ${bar.toLocaleString('en-US')} views in total`);
  const platforms = c.rules?.platforms;
  if (Array.isArray(platforms)) facts.push(`Counts on: ${platforms.map((p) => NAMES[String(p).toLowerCase()] ?? String(p)).join(', ')}`);
  if (typeof c.rules?.audience === 'string') facts.push(`Audience: ${c.rules.audience}`);
  const end = new Date(c.endsAt);
  facts.push(`Ends ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`);

  const days = Math.ceil((end.getTime() + 86_400_000 - now.getTime()) / 86_400_000); // endsAt counts through that day
  if (days <= 0) warnings.push('Ended: no new clips');
  else if (days <= SOON_DAYS) warnings.push(`Ends in ${days} day${days === 1 ? '' : 's'}: new clips have little time to get views`);
  if (!c.ratePer1k && bar >= HIGH_BAR) warnings.push('High bar: likely little or no pay');
  if (c.ratePer1k > 0 && c.ratePer1k < LOW_RATE) warnings.push('Low rate: likely little pay');
  return { facts, warnings };
}
