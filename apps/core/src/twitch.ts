// Minimal Twitch Helix client (app access token). Read-only: users, VODs, viewer clips.
const HELIX = 'https://api.twitch.tv/helix';
let token: { value: string; expires: number } | null = null;

async function appToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const q = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID ?? '',
    client_secret: process.env.TWITCH_CLIENT_SECRET ?? '',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://id.twitch.tv/oauth2/token?${q}`, { method: 'POST' });
  if (!res.ok) throw new Error(`twitch token: HTTP ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return token.value;
}

async function helix<T>(path: string, params: Record<string, string>): Promise<{ data: T[]; pagination?: { cursor?: string } }> {
  const res = await fetch(`${HELIX}/${path}?${new URLSearchParams(params)}`, {
    headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID ?? '', Authorization: `Bearer ${await appToken()}` },
  });
  if (res.status === 401) token = null;
  if (!res.ok) throw new Error(`twitch ${path}: HTTP ${res.status}`);
  return res.json() as any;
}

export interface Vod { id: string; user_id: string; user_login: string; title: string; created_at: string; duration: string; url: string }
export interface Clip { id: string; video_id: string; vod_offset: number | null; duration: number; view_count: number; created_at: string }

/** "3h2m1s" -> 10921 */
export function parseDuration(d: string): number {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(d);
  if (!m) throw new Error(`bad duration: ${d}`);
  return (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + +(m[3] ?? 0);
}

/** https://www.twitch.tv/videos/123456 -> "123456" */
export function vodIdFromUrl(url: string): string | null {
  return /twitch\.tv\/videos\/(\d+)/.exec(url)?.[1] ?? null;
}

export async function getUserId(login: string): Promise<string> {
  const { data } = await helix<{ id: string }>('users', { login });
  if (!data[0]) throw new Error(`twitch user not found: ${login}`);
  return data[0].id;
}

export async function getVod(id: string): Promise<Vod> {
  const { data } = await helix<Vod>('videos', { id });
  if (!data[0]) throw new Error(`twitch vod not found: ${id}`);
  return data[0];
}

export async function listVods(userId: string): Promise<Vod[]> {
  return (await helix<Vod>('videos', { user_id: userId, type: 'archive', first: '20' })).data;
}

/** Viewer-made clips of this VOD (Clips API, filtered on video_id; vod_offset = start in the VOD). */
export async function getVodClips(vod: Vod): Promise<Clip[]> {
  const start = new Date(vod.created_at);
  const end = new Date(start.getTime() + (parseDuration(vod.duration) + 3600) * 1000);
  const out: Clip[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const params: Record<string, string> = { broadcaster_id: vod.user_id, started_at: start.toISOString(), ended_at: end.toISOString(), first: '100' };
    if (after) params.after = after;
    const res = await helix<Clip>('clips', params);
    out.push(...res.data.filter((c) => c.video_id === vod.id && c.vod_offset != null));
    after = res.pagination?.cursor;
    if (!after) break;
  }
  return out;
}
