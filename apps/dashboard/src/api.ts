import { useQuery } from '@tanstack/react-query';

export interface Study { done: number; total: number; finished: boolean; error: string | null }
export interface Campaign {
  name: string; tag: string; status: string; open: boolean; on: boolean; stage: string; endsAt: string; daysLeft: number;
  ratePer1k: number; maxPerClip: number; pool: number | null; url: string | null; platforms: string[];
  views: number; earned: number; posts: number; perClip: unknown; study: Study | null; facts: string[]; warnings: string[];
}
export interface PostRow { id: number; clip: number; title: string | null; platform: string; url: string | null; postedAt: number | null; submitted: boolean; views: number; earned: number }
export interface CampaignDetail extends Campaign { hashtags: string[]; disclosure: boolean; clips: PostRow[] }
export interface Activity { kind: 'new' | 'kept' | 'skipped' | 'posted'; text: string; at: number }
export interface Overview {
  paused: boolean; working: number; failed: number; toReview: number; kept: number; skipped: number; posted: number; postedThisWeek: number;
  views: number; earned: number; reviewFrom: string[]; campaigns: Campaign[]; endingSoon: Campaign[]; canJoin: number; activity: Activity[];
}
export interface ReviewClip {
  id: number; streamer: string; seconds: number; at: number; title: string | null; hook: string | null; strength: number;
  reasons: string[]; warnings: string[]; source: string; platforms: string[]; tag: string | null; maxSec: number | null;
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
