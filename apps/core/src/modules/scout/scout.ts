// Scout: finds Content Rewards campaigns for Twitch streamers, joins them in the owner's CR Chrome (workers/cr_browser.py),
// reads the brief and saves them to streamers.yaml in the study stage. Making clips stays a manual switch on /campaigns.
// Numbers (rate, pool, budget, platforms) come from CR's own API data; the local model only reads tag, hashtags and account rules.
import { join } from 'node:path';
import { campaignOpen, type StreamerConfig } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { paths } from '../../env.ts';
import { logger } from '../../log.ts';
import { runCmd } from '../../proc.ts';
import { enqueue } from '../../queue/queue.ts';
import { allStreamers, extract, isGambling, toEntry, update } from '../../review/campaigns.ts';
import { bark } from '../../review/review.ts';

const log = logger('scout');
const PAGE = 'https://contentrewards.com/c/campaigns/';
const PAYING = ['tiktok', 'youtube', 'instagram'];
const DRUGS = /\b(puffco|cannabis|weed|thc|cbd|vapes?|nicotine)\b/i; // TikTok/IG ban drug promotion: account risk
const ASSUMED_DAYS = 30; // CR shows no end date; the budget check (campaignOpen) stops it earlier

export type CrCampaign = {
  id: string; name: string; description?: string; status: string; private: boolean; requiresApplication: boolean;
  organizationName?: string; budgetCents: number; payoutType: string; platforms: string[];
  payouts: { platform: string; payoutType: string; rateCents?: number; maxPayoutCents?: number }[];
  referenceMaterials?: { url: string }[]; metrics?: { budgetSpentCents?: number };
};

export const twitchOf = (c: CrCampaign) =>
  /twitch\.tv\/(\w{2,25})/i.exec([...(c.referenceMaterials ?? []).map((r) => r.url), c.description ?? ''].join(' '))?.[1]?.toLowerCase() ?? null;

/** Platforms where views pay: pool counts all listed, rate campaigns only those with a rate above 0. */
const paying = (c: CrCampaign) => c.payouts.filter((p) => PAYING.includes(p.platform) && (p.payoutType === 'pool' || (p.rateCents ?? 0) > 0)).map((p) => p.platform);

/** Campaigns worth joining: open, a Twitch streamer, paying on our platforms, no gambling, not saved yet. Biggest budget first. */
export function pickCampaigns(list: CrCampaign[], saved: StreamerConfig[], max = 3): CrCampaign[] {
  const urls = new Set(saved.map((s) => s.campaign?.url).filter(Boolean)), channels = new Set(saved.map((s) => s.channel));
  return list.filter((c) => c.status === 'active' && !c.private && !c.requiresApplication && paying(c).length
    && !isGambling([c.name, c.description, c.organizationName].join(' ')) && !DRUGS.test([c.name, c.description, c.organizationName].join(' '))
    && twitchOf(c) && !channels.has(twitchOf(c)!) && !urls.has(PAGE + c.id))
    .sort((a, b) => b.budgetCents - a.budgetCents).slice(0, max);
}

/** The form fields toEntry validates, from CR's data. Text-only fields (tag, hashtags, rules) come from the brief. */
export function formOf(c: CrCampaign, brief: { tag?: string; hashtags?: string[]; accountNote?: string; minViews?: number; }, now = new Date()) {
  const pays = c.payouts.filter((p) => paying(c).includes(p.platform));
  const pool = c.payoutType === 'pool';
  const left = c.budgetCents - (c.metrics?.budgetSpentCents ?? 0);
  return {
    name: twitchOf(c), channel: twitchOf(c), url: PAGE + c.id, platforms: paying(c), brief: [c.name, c.description].join(' '),
    ratePer1k: pool ? 0 : Math.max(...pays.map((p) => p.rateCents ?? 0)) / 100,
    maxPerClip: pool ? 0 : Math.max(0, ...pays.map((p) => p.maxPayoutCents ?? 0)) / 100,
    pool: pool ? c.budgetCents / 100 : 0, budgetLeft: left > 0 && left < c.budgetCents ? left / 100 : 0,
    endsAt: new Date(now.getTime() + ASSUMED_DAYS * 86_400_000).toISOString().slice(0, 10),
    tag: brief.tag ?? '', hashtags: brief.hashtags ?? [], accountNote: brief.accountNote ?? '', minViews: brief.minViews ?? 0,
    disclosure: true, // Content Rewards requires #ad on every post (FTC page), whatever the brief says
  };
}

const cr = async (...args: string[]) => JSON.parse(await runCmd(paths.pythonBin, ['-I', join(paths.rootDir, 'workers', 'cr_browser.py'), ...args]));

/** Text of public Google Docs rules pages linked from the campaign. */
async function rulesDocs(c: CrCampaign): Promise<string> {
  const links = [...new Set([...(c.referenceMaterials ?? []).map((r) => r.url), ...(c.description ?? '').match(/https:\/\/docs\.google\.com\/\S+/g) ?? []]
    .filter((u) => u.startsWith('https://docs.google.com/')))].slice(0, 3);
  const out: string[] = [];
  for (const u of links) {
    const r = await fetch(u, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (r?.ok) out.push((await r.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').slice(0, 8000));
  }
  return out.join('\n');
}

export async function scoutOnce(db: Db) {
  const { campaigns } = await cr('discover') as { campaigns: CrCampaign[] };
  const picks = pickCampaigns(campaigns, allStreamers());
  log.info(`${campaigns.length} campaigns, ${picks.length} new`);
  for (const c of picks) {
    try {
      const page = await cr('join', PAGE + c.id) as { joined: boolean; text: string };
      if (!page.joined) { log.warn(`could not join ${c.name}`); continue; }
      const text = [c.name, c.description, page.text, await rulesDocs(c)].join('\n');
      const { fields } = await extract(text, PAGE + c.id);
      if (fields.gambling || isGambling(text)) { log.warn(`${c.name} skipped: gambling`); continue; }
      const tag = fields.tag && text.toLowerCase().includes(fields.tag.replace(/^@/, '').toLowerCase()) ? fields.tag : ''; // only a tag written in the brief
      const entry = toEntry(formOf(c, { ...fields, tag }));
      if (!campaignOpen(entry.campaign!)) continue;
      entry.enabled = true;
      entry.campaign!.rules = { ...entry.campaign!.rules, endsAtAssumed: true };
      update(entry.name, entry, true);
      enqueue(db, 'campaign.study', { name: entry.name }, { maxAttempts: 2 });
      log.info(`joined and saved ${entry.name} (${c.name})`);
      await bark(`New campaign · ${entry.name}`, `Joined "${c.name}". Studying top clips now; switch on clips at /campaigns.`, { url: PAGE + c.id, level: 'passive' });
    } catch (e) { log.error(`${c.name} failed`, { error: String(e) }); }
  }
}
