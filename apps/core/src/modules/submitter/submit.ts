// Submitter: campaigns pay only for links submitted within ~30 minutes of posting. Content Rewards has no official
// submission API (checked 2026-11-24), so the owner gets a push with the post link copied and the campaign page one tap away.
// shortcut: manual submit; automate it if the campaign platform gets an official API.
import { eq } from 'drizzle-orm';
import { loadSettings } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { clips, moments, posts } from '../../db/schema.ts';
import { logger } from '../../log.ts';
import { bark } from '../../review/review.ts';
import { hasPostpeer } from '../publisher/postpeer.ts';
import { sourceContext } from '../vod-clipper/analyze.ts';

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
  await bark(`Submit now · ${cfg.name} · ${post.platform}`, `Link copied. Paste it in the campaign within 30 minutes: ${post.url}`,
    { url: cfg.campaign.url ?? post.url!, copy: post.url!, level: 'timeSensitive' });
  db.update(posts).set({ submitted: true }).where(eq(posts.id, postId)).run(); // asked once: a second push could make a double submit
  log.info(`asked owner to submit post ${postId}`);
}
