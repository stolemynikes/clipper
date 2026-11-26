// Scout: finds Content Rewards campaigns for Twitch streamers, joins them in the owner's CR Chrome (workers/cr_browser.py),
// reads the brief and saves them to streamers.yaml in the study stage. Making clips stays a manual switch on /campaigns.
// Numbers (rate, pool, budget, platforms) come from CR's own API data; the local model only reads tag, hashtags and account rules.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { campaignOpen, type StreamerConfig } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { paths } from '../../env.ts';
import { logger } from '../../log.ts';
import { runCmd } from '../../proc.ts';
import { enqueue } from '../../queue/queue.ts';
import { allStreamers, extract, isGambling, toEntry, update, updateCampaign } from '../../review/campaigns.ts';
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

/** Why a campaign can't be joined (plain words for the dashboard), or null when it can. */
export function whyNot(c: CrCampaign, saved: StreamerConfig[]): string | null {
  const text = [c.name, c.description, c.organizationName].join(' ');
  if (c.status !== 'active') return 'Not running';
  if (c.private) return 'Private';
  if (c.requiresApplication) return 'Needs an application';
  if (isGambling(text)) return 'Gambling';
  if (DRUGS.test(text)) return 'Drugs or vapes';
  if (!paying(c).length) return 'Pays on no platform we post to';
  const ch = twitchOf(c);
  if (!ch) return 'No Twitch streamer';
  if (saved.some((s) => s.channel === ch || s.campaign?.url === PAGE + c.id)) return 'Already joined';
  return null;
}

/** Campaigns worth joining: open, a Twitch streamer, paying on our platforms, no gambling, not saved yet. Biggest budget first. */
export function pickCampaigns(list: CrCampaign[], saved: StreamerConfig[], max = 3): CrCampaign[] {
  return list.filter((c) => !whyNot(c, saved)).sort((a, b) => b.budgetCents - a.budgetCents).slice(0, max);
}

/** The form fields toEntry validates, from CR's data. Text-only fields (tag, hashtags, rules) come from the brief. */
export function formOf(c: CrCampaign, brief: { tag?: string; hashtags?: string[]; accountNote?: string; contentRules?: string; disclosure?: boolean; minViews?: number; totalViews?: number; endsAt?: string }, now = new Date()) {
  const pays = c.payouts.filter((p) => paying(c).includes(p.platform));
  const pool = c.payoutType === 'pool';
  const left = c.budgetCents - (c.metrics?.budgetSpentCents ?? 0);
  return {
    name: twitchOf(c), channel: twitchOf(c), url: PAGE + c.id, platforms: paying(c), brief: [c.name, c.description].join(' '),
    ratePer1k: pool ? 0 : Math.max(...pays.map((p) => p.rateCents ?? 0)) / 100,
    maxPerClip: pool ? 0 : Math.max(0, ...pays.map((p) => p.maxPayoutCents ?? 0)) / 100,
    pool: pool ? c.budgetCents / 100 : 0, budgetLeft: left > 0 && left < c.budgetCents ? left / 100 : 0,
    endsAt: datedEnd(brief.endsAt, now) ?? new Date(now.getTime() + ASSUMED_DAYS * 86_400_000).toISOString().slice(0, 10),
    tag: brief.tag ?? '', hashtags: brief.hashtags ?? [], accountNote: brief.accountNote ?? '', contentRules: brief.contentRules ?? '', minViews: brief.minViews ?? 0, totalViews: brief.totalViews ?? 0,
    disclosure: brief.disclosure === true, // owner 2026-11-25: #ad only when the brief itself asks for it
  };
}

const cr = async (...args: string[]) => JSON.parse(await runCmd(paths.pythonBin, ['-I', join(paths.rootDir, 'workers', 'cr_browser.py'), ...args]));

/** End date written in the brief (YYYY-MM-DD), only when it is a real date that has not passed. */
export const datedEnd = (d: string | undefined, now = new Date()) =>
  d && /^\d{4}-\d{2}-\d{2}$/.test(d) && Date.parse(d) + 86_400_000 > now.getTime() ? d : undefined;

const SOCIAL = /^https:\/\/([\w-]+\.)?(twitch\.tv|youtube\.com|youtu\.be|tiktok\.com|instagram\.com|x\.com|twitter\.com|kick\.com|snapchat\.com|discord\.(gg|com))\//i;
/** Text of the rules pages linked from the campaign (Google Docs, a "Rules & Requirements" site), not the streamer's social links. */
async function rulesDocs(c: CrCampaign): Promise<string> {
  const links = [...new Set([...(c.referenceMaterials ?? []).map((r) => r.url), ...(c.description ?? '').match(/https:\/\/docs\.google\.com\/\S+/g) ?? []]
    .filter((u) => u.startsWith('https://') && !SOCIAL.test(u)))].slice(0, 3);
  const out: string[] = [];
  for (const u of links) {
    const r = await fetch(u, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (r?.ok) out.push((await r.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').slice(0, 8000));
  }
  return out.join('\n');
}

const DISCOVER_FILE = join(paths.dataDir, 'cr-discover.json');

/** Reads every campaign on CR's Discover page and caches the list for the dashboard. */
export async function discoverAll(): Promise<CrCampaign[]> {
  const { campaigns, joined } = await cr('discover') as { campaigns: CrCampaign[]; joined?: JoinedCard[] };
  writeFileSync(DISCOVER_FILE, JSON.stringify({ at: new Date().toISOString(), campaigns, joined: joined ?? [] }));
  syncCrState();
  return campaigns;
}

/** Copies CR's closed flag and budget left into streamers.yaml, so campaignOpen() stops clips for closed or spent campaigns. */
export function syncCrState(scan = cachedDiscover(), list = allStreamers(), save = updateCampaign) {
  for (const s of list) {
    const c = s.campaign;
    if (c?.platform !== 'content_rewards') continue;
    const st = crState(c.url, [s.name, s.channel], scan);
    if (!st) continue;
    const budgetLeft = st.budget > 0 ? st.left : c.budgetLeft;
    if (st.closed === Boolean(c.closed) && budgetLeft === c.budgetLeft) continue;
    save(s.name, { closed: st.closed, ...(budgetLeft != null ? { budgetLeft } : {}) });
    log.info(`${s.name}: CR submissions ${st.closed ? 'closed' : 'open'}${st.budget ? `, $${st.left} of $${st.budget} left` : ''}`);
  }
}

/** A card on CR's "Your Campaigns" (server-rendered, so text only): spent/budget as shown, e.g. "1,750" or "1.2K". */
export type JoinedCard = { name: string; closed: boolean; spent: string | null; budget: string | null };

export const cachedDiscover = (): { at: string | null; campaigns: CrCampaign[]; joined?: JoinedCard[] } =>
  existsSync(DISCOVER_FILE) ? JSON.parse(readFileSync(DISCOVER_FILE, 'utf8')) : { at: null, campaigns: [] };

const usd = (v: string | null) => v ? Number(v.replace(/,/g, '').replace(/K$/i, 'e3')) : null;
const flat = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Live CR state of a joined campaign from the last scan: submissions closed, and budget left when CR shows it. */
export function crState(url: string | undefined, names: string[], scan = cachedDiscover()): { closed: boolean; budget: number; left: number } | null {
  const id = url?.split('/').pop(), c = scan.campaigns.find((x) => x.id === id);
  // shortcut: cards carry no id, so match by the open campaign's name, else by streamer name in the card title
  const card = (scan.joined ?? []).find((j) => c ? j.name === c.name : names.some((n) => n && flat(j.name).includes(flat(n))));
  if (c) return { closed: Boolean(card?.closed), budget: c.budgetCents / 100, left: Math.max(0, c.budgetCents - (c.metrics?.budgetSpentCents ?? 0)) / 100 };
  if (!card) return null;
  const spent = usd(card.spent), budget = usd(card.budget);
  return { closed: card.closed, budget: budget ?? 0, left: budget != null && spent != null ? Math.max(0, budget - spent) : 0 };
}

/** Joins one campaign on CR, reads the brief, saves it and starts the study. Returns the saved name, or why it stopped. */
export async function joinCampaign(db: Db, c: CrCampaign): Promise<{ name?: string; reason?: string }> {
  const page = await cr('join', PAGE + c.id, c.name) as { joined: boolean; text: string; docs?: string };
  if (!page.joined) return { reason: 'CR did not confirm the join' };
  const text = [c.name, c.description, page.text, page.docs ?? '', await rulesDocs(c)].join('\n');
  const { fields } = await extract(text, PAGE + c.id);
  if (fields.gambling || isGambling(text)) return { reason: 'The brief is about gambling' };
  const tag = fields.tag && text.toLowerCase().includes(fields.tag.replace(/^@/, '').toLowerCase()) ? fields.tag : ''; // only a tag written in the brief
  const entry = toEntry(formOf(c, { ...fields, tag }));
  if (!campaignOpen(entry.campaign!)) return { reason: 'Budget or time is used up' };
  if (!datedEnd(fields.endsAt)) entry.campaign!.rules = { ...entry.campaign!.rules, endsAtAssumed: true };
  update(entry.name, entry, true); // opt-in: owner starts study/clips on the campaign page
  log.info(`joined and saved ${entry.name} (${c.name})`);
  return { name: entry.name };
}

/** Job campaign.join {id}: joins a campaign from the cached Discover list (dashboard button). */
export async function joinJob(db: Db, { id }: { id: string }) {
  const c = cachedDiscover().campaigns.find((x) => x.id === id);
  if (!c) throw new Error(`campaign ${id} not in the Discover list`);
  const why = whyNot(c, allStreamers());
  if (why) throw new Error(`can't join: ${why}`);
  const r = await joinCampaign(db, c);
  if (!r.name) throw new Error(r.reason);
}

export async function scoutOnce(db: Db) {
  const campaigns = await discoverAll();
  const picks = pickCampaigns(campaigns, allStreamers());
  log.info(`${campaigns.length} campaigns, ${picks.length} new`);
  for (const c of picks) {
    try {
      const r = await joinCampaign(db, c);
      if (!r.name) { log.warn(`${c.name} skipped: ${r.reason}`); continue; }
      await bark(`New campaign · ${r.name}`, `Joined "${c.name}". Studying top clips now; switch on clips at /campaigns.`, { url: PAGE + c.id, level: 'passive' });
    } catch (e) { log.error(`${c.name} failed`, { error: String(e) }); }
    await new Promise((r) => setTimeout(r, 30_000 + Math.random() * 90_000)); // one at a time with a person's gap, not all at once
  }
}
