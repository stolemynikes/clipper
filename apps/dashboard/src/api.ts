import { useQuery } from '@tanstack/react-query';

export interface Study { done: number; total: number; finished: boolean; error: string | null }
export interface Campaign {
  name: string; tag: string; status: string; open: boolean; on: boolean; stage: string; endsAt: string; daysLeft: number;
  /** From the last CR scan: submissions closed, and budget left (null when CR shows none). */
  closed: boolean; budget: number | null; left: number | null;
  ratePer1k: number; maxPerClip: number; pool: number | null; url: string | null; platforms: string[]; site: string;
  views: number; earned: number; posts: number; perClip: unknown; study: Study | null; facts: string[]; warnings: string[];
}
export interface PostRow { id: number; clip: number; title: string | null; platform: string; url: string | null; postedAt: number | null; submitted: boolean; views: number; earned: number }
export interface CampaignDetail extends Campaign { hashtags: string[]; disclosure: boolean; clips: PostRow[] }
export interface Activity { kind: 'new' | 'kept' | 'skipped' | 'posted'; text: string; at: number }
export interface Overview {
  paused: boolean; study: boolean; learning: boolean; practice: boolean; claude: boolean; working: number; failed: number; toReview: number; kept: number; skipped: number; posted: number; postedThisWeek: number;
  views: number; earned: number; reviewFrom: string[]; campaigns: Campaign[]; endingSoon: Campaign[]; canJoin: number; activity: Activity[];
  earnedSeries: number[]; earnedWeek: number; viewsWeek: number; viewsPrevWeek: number; reviewIds: number[]; sites: string[];
}
export interface ReviewClip {
  id: number; streamer: string; seconds: number; at: number; title: string | null; hook: string | null; strength: number;
  reasons: string[]; warnings: string[]; source: string; platforms: string[]; tag: string | null; maxSec: number | null;
}

export interface Proposal {
  id: string; title: string; why: string; status: 'testing' | 'ready' | 'approved' | 'rejected'; allPairs: number;
  score: { wins: number; n: number; share: number; low: number; high: number } | null;
  aa: { n: number; biased: boolean; firstShare: number | null; sameShare: number | null };
  frames: { clipId: number; old: string; new: string }[];
  untested?: boolean; evidence?: string; change: { titleExamples?: string[] };
}

const get = async <T,>(path: string): Promise<T> => {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

/** Same header the old review page sends; the server refuses POSTs without it. */
export const post = async (path: string, body?: object) => {
  const r = await fetch(path, { method: 'POST', headers: { 'x-clipper': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok && r.status !== 204) throw new Error(((r.status === 400 || r.status === 409) && await r.text()) || `${r.status}`);
};

const live = { refetchInterval: 15_000 };
export const useOverview = () => useQuery({ queryKey: ['overview'], queryFn: () => get<Overview>('/api/overview'), ...live });
export const useReview = () => useQuery({ queryKey: ['review'], queryFn: () => get<ReviewClip[]>('/api/review'), ...live });
export const useCampaigns = () => useQuery({ queryKey: ['campaigns'], queryFn: () => get<Campaign[]>('/api/campaigns'), ...live });
export const useCampaign = (name: string) => useQuery({ queryKey: ['campaign', name], queryFn: () => get<CampaignDetail>(`/api/campaigns/${name}`), ...live });

export const useProposals = () => useQuery({ queryKey: ['proposals'], queryFn: () => get<Proposal[]>('/api/proposals'), ...live });

// Client-only settings (localStorage): currency, payout fee %, app name. Nothing is invented: no fee unless the owner sets one.
export const pref = (k: string, d = '') => localStorage.getItem(`snip.${k}`) ?? d;
export const setPref = (k: string, v: string) => { localStorage.setItem(`snip.${k}`, v); window.dispatchEvent(new Event('snip-pref')); };
let eurPerUsd: number | null = null;
export const setRate = (r: number | null) => { eurPerUsd = r; };
/** USD amounts shown in EUR when the owner picked EUR and the ECB rate is known. */
export const isEur = () => pref('currency') === 'eur' && eurPerUsd != null;
export const fee = () => Math.min(50, Math.max(0, Number(pref('fee', '0')) || 0));
export const money = (n: number, cents = false) => {
  const v = isEur() ? n * eurPerUsd! : n, d = cents || (v < 1000 && v !== 0) ? 2 : 0;
  return `${isEur() ? '€' : '$'}${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
export const short = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : count(n));
export const count = (n: number) => n.toLocaleString('en-US');
export const PLATFORM: Record<string, string> = { tiktok: 'TikTok', youtube: 'YouTube Shorts', instagram: 'Instagram Reels', x: 'X' };

export function ago(ms: number, now = Date.now()) {
  const m = Math.round((now - ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
}

export interface Payout { id: number; campaign: string; amount: number; status: 'pending' | 'paid'; note: string | null; paidAt: number | null; at: number }
export interface EarnCampaign { name: string; site: string; status: string; open: boolean; endsAt: string; daysLeft: number; views: number; posts: number; earned: number; pool: number | null; paid: number }
export interface Earnings { estimated: number; paid: number; pending: number; payouts: Payout[]; campaigns: EarnCampaign[]; platforms: { platform: string; label: string; views: number; posts: number; share: number }[] }
export interface HistoryRow extends PostRow { streamer: string }
export interface Month { month: string; clips: number; views: number; earned: number; paid: number; campaigns: number }
export interface History { months: Month[]; ended: { name: string; endsAt: string; earned: number; posts: number; paid: number }[]; posts: HistoryRow[] }
export interface Account { id: number; platform: string; label: string; name: string; streamer: string | null; pool: boolean; posts: number; views: number; earned: number; connected: boolean; today: number;
  via: 'oauth' | 'postpeer' | 'needs_postpeer'; connectUrl: string }
export interface AppSetup { platform: string; label: string; ready: boolean; steps: string[]; fields: { key: string; label: string; secret: boolean; saved: boolean }[] }
export interface Accounts { limit: number; hours: (number | null)[][]; accounts: Account[]; apps: AppSetup[]; campaigns: { id: number; name: string }[];
  hasPostpeer: boolean; canCheckNames: boolean; titleTest: string }
export const useEarnings = () => useQuery({ queryKey: ['earnings'], queryFn: () => get<Earnings>('/api/earnings'), ...live });
export const useHistory = () => useQuery({ queryKey: ['history'], queryFn: () => get<History>('/api/history'), ...live });
export type DiscoverCampaign = { id: string; name: string; org: string; streamer: string | null; pool: boolean; budget: number; left: number;
  pays: { platform: string; ratePer1k: number; maxPerClip: number }[]; why: string | null; joining: boolean; joinError: string | null };
export type Discover = { at: string | null; scanning: boolean; scanError: string | null; campaigns: DiscoverCampaign[] };
/** Polls every 3s while a scan or join runs, else the normal 15s. */
export const useDiscover = () => useQuery({ queryKey: ['discover'], queryFn: () => get<Discover>('/api/discover'),
  refetchInterval: (q) => (q.state.data?.scanning || q.state.data?.campaigns.some((c) => c.joining) ? 3_000 : 15_000) });
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => get<Accounts>('/api/accounts'), ...live });
export interface SettingField {
  key: string; group: string; label: string; help: string; type: 'number' | 'bool' | 'choice';
  min?: number; max?: number; step?: number; unit?: string; options?: string[]; value: number | boolean | string | null;
}
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => get<SettingField[]>('/api/settings') });
export const useRate = () => useQuery({ queryKey: ['rate'], queryFn: () => get<{ eurPerUsd: number | null; date: string }>('/api/rate'), staleTime: 3_600_000 });
