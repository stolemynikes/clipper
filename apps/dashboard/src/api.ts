import { useQuery } from '@tanstack/react-query';

export interface Study { done: number; total: number; finished: boolean; error: string | null }
export interface Campaign {
  name: string; tag: string; status: string; open: boolean; on: boolean; stage: string; endsAt: string; daysLeft: number;
  ratePer1k: number; maxPerClip: number; pool: number | null; url: string | null; platforms: string[]; site: string;
  views: number; earned: number; posts: number; perClip: unknown; study: Study | null; facts: string[]; warnings: string[];
}
export interface PostRow { id: number; clip: number; title: string | null; platform: string; url: string | null; postedAt: number | null; submitted: boolean; views: number; earned: number }
export interface CampaignDetail extends Campaign { hashtags: string[]; disclosure: boolean; clips: PostRow[] }
export interface Activity { kind: 'new' | 'kept' | 'skipped' | 'posted'; text: string; at: number }
export interface Overview {
  paused: boolean; study: boolean; learning: boolean; practice: boolean; claude: boolean; working: number; failed: number; toReview: number; kept: number; skipped: number; posted: number; postedThisWeek: number;
  views: number; earned: number; reviewFrom: string[]; campaigns: Campaign[]; endingSoon: Campaign[]; canJoin: number; activity: Activity[];
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
  untested?: boolean; change: { titleExamples?: string[] };
}

const get = async <T,>(path: string): Promise<T> => {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

/** Same header the old review page sends; the server refuses POSTs without it. */
export const post = async (path: string) => {
  const r = await fetch(path, { method: 'POST', headers: { 'x-clipper': '1' } });
  if (!r.ok && r.status !== 204) throw new Error(`${r.status}`);
};

const live = { refetchInterval: 15_000 };
export const useOverview = () => useQuery({ queryKey: ['overview'], queryFn: () => get<Overview>('/api/overview'), ...live });
export const useReview = () => useQuery({ queryKey: ['review'], queryFn: () => get<ReviewClip[]>('/api/review'), ...live });
export const useCampaigns = () => useQuery({ queryKey: ['campaigns'], queryFn: () => get<Campaign[]>('/api/campaigns'), ...live });
export const useCampaign = (name: string) => useQuery({ queryKey: ['campaign', name], queryFn: () => get<CampaignDetail>(`/api/campaigns/${name}`), ...live });

export const useProposals = () => useQuery({ queryKey: ['proposals'], queryFn: () => get<Proposal[]>('/api/proposals'), ...live });

export const money = (n: number) => { const d = n >= 1000 || n === 0 ? 0 : 2; return `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`; };
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
export interface Earnings { estimated: number; paid: number; pending: number; payouts: Payout[]; campaigns: { name: string; views: number; posts: number; earned: number; pool: number | null; paid: number }[] }
export interface HistoryRow extends PostRow { streamer: string }
export interface Account { id: number; platform: string; label: string; name: string; streamer: string | null; pool: boolean; posts: number; views: number; earned: number; connected: boolean }
export const useEarnings = () => useQuery({ queryKey: ['earnings'], queryFn: () => get<Earnings>('/api/earnings'), ...live });
export const useHistory = () => useQuery({ queryKey: ['history'], queryFn: () => get<HistoryRow[]>('/api/history'), ...live });
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => get<Account[]>('/api/accounts'), ...live });
