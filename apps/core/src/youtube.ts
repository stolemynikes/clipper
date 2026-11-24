// Read-only YouTube Data API v3 (API key): find the most-viewed public Shorts about a streamer.
// Used only to study layout and editing; we never repost these videos.
const API = 'https://www.googleapis.com/youtube/v3';

export interface Short { id: string; title: string; channel: string; views: number; url: string }

export const hasYoutubeKey = () => !!process.env.YOUTUBE_API_KEY;

async function yt<T>(path: string, params: Record<string, string>): Promise<{ items: T[] }> {
  const res = await fetch(`${API}/${path}?${new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY ?? '' })}`);
  if (!res.ok) throw new Error(`youtube ${path}: HTTP ${res.status}`); // never include the URL: it holds the key
  return res.json() as any;
}

/** search.list costs 100 quota units of the 10,000 free per day; videos.list costs 1. */
export async function topShorts(query: string, since: Date, max = 10): Promise<Short[]> {
  const found = await yt<{ id: { videoId: string } }>('search', {
    part: 'id', q: `${query} #shorts`, type: 'video', videoDuration: 'short', order: 'viewCount',
    publishedAfter: since.toISOString(), maxResults: String(max),
  });
  const ids = found.items.map((i) => i.id.videoId).join(',');
  if (!ids) return [];
  const { items } = await yt<{ id: string; snippet: { title: string; channelTitle: string }; statistics: { viewCount?: string } }>(
    'videos', { part: 'snippet,statistics', id: ids });
  return items.map((v) => ({ id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle, views: Number(v.statistics.viewCount ?? 0),
    url: `https://www.youtube.com/shorts/${v.id}` })).sort((a, b) => b.views - a.views);
}
