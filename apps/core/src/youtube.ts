// Read-only YouTube Data API v3 (API key): find the most-viewed public Shorts about a streamer.
// Used only to study layout and editing; we never repost these videos.
const API = 'https://www.googleapis.com/youtube/v3';

export interface Short {
  id: string; title: string; channel: string; channelId: string; views: number; url: string;
  description: string; tags: string[]; durationSec: number; likes: number; comments: number; publishedAt: string; lang: string;
}

/** ISO 8601 duration from videos.list ("PT1M5S") to seconds. */
export const isoSeconds = (d: string) => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d ?? ''); return m ? (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0)) : 0; };

export const hasYoutubeKey = () => !!process.env.YOUTUBE_API_KEY;

async function yt<T>(path: string, params: Record<string, string>): Promise<{ items: T[] }> {
  const res = await fetch(`${API}/${path}?${new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY ?? '' })}`);
  if (!res.ok) throw new Error(`youtube ${path}: HTTP ${res.status}`); // never include the URL: it holds the key
  return res.json() as any;
}

/** search.list costs 100 quota units of the 10,000 free per day; videos.list costs 1. */
/** extra: more search.list params, e.g. { videoCategoryId: '20' } (Gaming), { relevanceLanguage: 'en' }. */
export async function topShorts(query: string, since: Date, max = 10, extra: Record<string, string> = {}): Promise<Short[]> {
  const found = await yt<{ id: { videoId: string } }>('search', {
    part: 'id', q: `${query} #shorts`, type: 'video', videoDuration: 'short', order: 'viewCount',
    publishedAfter: since.toISOString(), maxResults: String(max), ...extra,
  });
  const ids = found.items.map((i) => i.id.videoId).join(',');
  if (!ids) return [];
  const { items } = await yt<{ id: string; snippet: { title: string; channelTitle: string; description?: string; tags?: string[]; publishedAt: string; defaultAudioLanguage?: string; defaultLanguage?: string };
    statistics: { viewCount?: string; likeCount?: string; commentCount?: string }; contentDetails: { duration: string } }>(
    'videos', { part: 'snippet,statistics,contentDetails', id: ids });
  return toShorts(items);
}

const toShorts = (items: any[]): Short[] => items.map((v) => ({ id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle, channelId: v.snippet.channelId ?? '', views: Number(v.statistics.viewCount ?? 0),
    url: `https://www.youtube.com/shorts/${v.id}`, description: v.snippet.description ?? '', tags: v.snippet.tags ?? [],
    durationSec: isoSeconds(v.contentDetails.duration), likes: Number(v.statistics.likeCount ?? 0), comments: Number(v.statistics.commentCount ?? 0),
    publishedAt: v.snippet.publishedAt, lang: v.snippet.defaultAudioLanguage ?? v.snippet.defaultLanguage ?? '' })).sort((a, b) => b.views - a.views);

/** A channel's own recent Shorts (3-30 days old, so views have mostly settled): the newest 50 uploads, 2 quota units. */
export async function channelShorts(channelId: string, now = Date.now()): Promise<Short[]> {
  if (!/^UC[\w-]{22}$/.test(channelId)) return [];
  const pl = await yt<{ contentDetails: { videoId: string } }>('playlistItems', { part: 'contentDetails', playlistId: `UU${channelId.slice(2)}`, maxResults: '50' });
  const ids = pl.items.map((i) => i.contentDetails.videoId).join(',');
  if (!ids) return [];
  const { items } = await yt<any>('videos', { part: 'snippet,statistics,contentDetails', id: ids });
  return toShorts(items).filter((v) => { const age = (now - Date.parse(v.publishedAt)) / 86_400_000; return v.durationSec > 0 && v.durationSec <= 180 && age >= 3 && age <= 30; });
}
