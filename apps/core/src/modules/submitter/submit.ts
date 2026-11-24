// Submitter: campaigns pay only for links submitted within ~30 minutes of posting. With a campaign's whopBountyId set and
// Whop linked (scripts/whop-login.ts), the link goes in via the official Whop API (POST /bounty_submissions, owner's OAuth).
// Otherwise, or if that fails, the owner gets a push with the post link copied and the campaign page one tap away.
// shortcut: bounty ids are filled in by hand; GET /bounties refuses user OAuth tokens (checked 2026-11-24).
import { eq } from 'drizzle-orm';
import { loadSettings } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { clips, moments, posts } from '../../db/schema.ts';
import { logger } from '../../log.ts';
import { bark } from '../../review/review.ts';
import { hasPostpeer } from '../publisher/postpeer.ts';
import { sourceContext } from '../vod-clipper/analyze.ts';
import { hasWhop, whopApi } from './whop.ts';

const log = logger('submitter');

const WINDOW_MS = 30 * 60_000; // Terms 7.12: submit within 30 minutes of posting

/** Why a post must not be submitted, or null. One campaign per post and never twice (Terms 7.11); must be public. */
export function submitBlock(p: { url: string | null; submitted: boolean; postedAt: Date | null; platform: string }, now: Date, tiktokPrivate: boolean): string | null {
  if (!p.url) return 'no link yet';
  if (p.submitted) return 'already asked once';
  if (!p.postedAt || now.getTime() - p.postedAt.getTime() > WINDOW_MS) return 'over 30 minutes after posting';
  if (p.platform === 'tiktok' && tiktokPrivate) return 'TikTok post is private';
  return null;
}

export async function askSubmit(db: Db, { postId }: { postId: number }) {
  const post = db.select().from(posts).where(eq(posts.id, postId)).get();
  if (!post) return;
  const block = submitBlock(post, new Date(), !hasPostpeer() && !loadSettings().publish?.tiktokPublic);
  if (block) return log.info(`post ${postId} not submitted: ${block}`);
  const clip = db.select().from(clips).where(eq(clips.id, post.clipId)).get()!;
  const moment = db.select().from(moments).where(eq(moments.id, clip.momentId)).get()!;
  const { cfg } = sourceContext(db, moment.sourceId);
  if (!cfg.campaign) return;
  if (cfg.campaign.whopBountyId && hasWhop()) {
    // Mark first: a crash after a successful POST must not lead to a second submit (Terms 7.11). Idempotency-Key covers retries.
    db.update(posts).set({ submitted: true }).where(eq(posts.id, postId)).run();
    try {
      const r = await whopApi('/bounty_submissions', {
        method: 'POST', headers: { 'Idempotency-Key': `post-${postId}` },
        body: { bounty_id: cfg.campaign.whopBountyId, deliverable: { urls: [post.url!] } },
      });
      if (r.status < 300) {
        log.info(`post ${postId} submitted to Whop bounty ${cfg.campaign.whopBountyId}`);
        await bark(`Submitted · ${cfg.name} · ${post.platform}`, post.url!, { url: post.url! });
        return;
      }
      log.warn(`post ${postId} auto-submit failed: HTTP ${r.status} ${r.body?.error?.message ?? ''}`);
    } catch (e) {
      log.warn(`post ${postId} auto-submit failed: ${(e as Error).message}`);
    }
  }
  await bark(`Submit now · ${cfg.name} · ${post.platform}`, `Link copied. Paste it in the campaign within 30 minutes: ${post.url}`,
    { url: cfg.campaign.url ?? post.url!, copy: post.url!, level: 'timeSensitive' });
  db.update(posts).set({ submitted: true }).where(eq(posts.id, postId)).run(); // asked once: a second push could make a double submit
  log.info(`asked owner to submit post ${postId}`);
}
