// Posting to TikTok and Instagram through PostPeer (https://docs.postpeer.dev): its own audited apps post public,
// unlimited connected accounts. Flow: upload the file to PostPeer storage, create the post, poll, delete the file.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { logger } from '../../log.ts';

const log = logger('postpeer');
const BASE = 'https://api.postpeer.dev/v1';

export const hasPostpeer = () => Boolean(process.env.POSTPEER_API_KEY);
export type PpPlatform = 'tiktok' | 'instagram';
type Integration = { id: string; platform: string; displayName?: string; platformUserId?: string };

async function pp<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'x-access-key': process.env.POSTPEER_API_KEY ?? '', ...(init.body !== undefined && { 'content-type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const j = await r.json().catch(() => ({})) as T & { error?: unknown; message?: string };
  if (!r.ok) throw new Error(`PostPeer ${init.method ?? 'GET'} ${path} failed: ${r.status} ${JSON.stringify(j.error ?? j.message ?? '').slice(0, 200)}`);
  return j;
}

const norm = (s = '') => s.toLowerCase().replace(/^@/, '').trim();

/** The PostPeer account for a local account: same name, or the only one connected on that platform. */
export function pickIntegration(list: Integration[], platform: PpPlatform, name: string): Integration | undefined {
  const own = list.filter((i) => i.platform === platform);
  return own.find((i) => norm(i.displayName) === norm(name) || norm(i.platformUserId) === norm(name)) ?? (own.length === 1 ? own[0] : undefined);
}

export function postBody(o: { platform: PpPlatform; integrationId: string; content: string; url: string; paid: boolean; key: string }) {
  const platformSpecificData = o.platform === 'tiktok'
    ? { privacyLevel: 'PUBLIC_TO_EVERYONE', disableComment: false, disableDuet: false, disableStitch: false, brandContentToggle: o.paid, brandOrganicToggle: false, isAigc: false }
    : { shareToFeed: true };
  return {
    content: o.content,
    platforms: [{ platform: o.platform, accountId: o.integrationId, platformSpecificData }],
    mediaItems: [{ type: 'video', url: o.url }],
    publishNow: true,
    idempotencyKey: o.key, // a retry after a crash replays the same post instead of posting twice
  };
}

type PlatformResult = { platform: string; status?: string; success?: boolean; platformPostId?: string; platformPostUrl?: string; error?: string; errorMessage?: string };

export async function postpeerPublish(o: { platform: PpPlatform; accountName: string; file: string; content: string; paid: boolean; key: string }) {
  const { integrations } = await pp<{ integrations: Integration[] }>(`/connect/integrations?platform=${o.platform}&limit=100`);
  const acc = pickIntegration(integrations, o.platform, o.accountName);
  if (!acc) throw new Error(`no ${o.platform} account "${o.accountName}" connected in PostPeer (connect it on postpeer.dev)`);

  const up = await pp<{ data: { uploadUrl: string; publicUrl: string } }>('/media/upload', {
    method: 'POST', body: { filename: basename(o.file), mimeType: 'video/mp4', sizeBytes: statSync(o.file).size } });
  const put = await fetch(up.data.uploadUrl, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: readFileSync(o.file) });
  if (!put.ok) throw new Error(`PostPeer file upload failed: ${put.status}`);

  let keepFile = false;
  try {
    const res = await pp<{ status: string; postId: string; platforms?: PlatformResult[] }>('/posts', {
      method: 'POST', body: postBody({ platform: o.platform, integrationId: acc.id, content: o.content, url: up.data.publicUrl, paid: o.paid, key: o.key }) });
    let p = res.platforms?.[0];
    let status = res.status;
    // Videos are processed async: poll up to ~5 minutes.
    for (let i = 0; i < 30 && !['published', 'failed', 'partial'].includes(status); i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      const g = await pp<{ post: { status: string; platforms: PlatformResult[] } }>(`/posts/${res.postId}`);
      status = g.post.status;
      p = g.post.platforms[0];
    }
    if (status === 'failed' || p?.success === false || p?.status === 'failed') throw new Error(`PostPeer post failed: ${p?.errorMessage ?? p?.error ?? status}`);
    if (status !== 'published') {
      keepFile = true; // shortcut: still processing, file stays in storage (100 MB free); clean up by hand if storage fills (413)
      log.warn(`PostPeer post ${res.postId} still ${status} after 5 minutes`);
    }
    return { externalId: `pp:${res.postId}`, url: p?.platformPostUrl ?? null };
  } finally {
    if (!keepFile) await pp('/media', { method: 'DELETE', body: { url: up.data.publicUrl } }).catch((e) => log.warn(`could not delete PostPeer file: ${(e as Error).message}`));
  }
}
