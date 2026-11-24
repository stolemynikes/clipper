// Submitter: campaigns pay only for links submitted within ~30 minutes of posting. Content Rewards has no official
// submission API (checked 2026-11-24), so the owner gets a push with the post link copied and the campaign page one tap away.
// shortcut: manual submit; automate it if the campaign platform gets an official API.
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { clips, moments, posts } from '../../db/schema.ts';
import { logger } from '../../log.ts';
import { bark } from '../../review/review.ts';
import { sourceContext } from '../vod-clipper/analyze.ts';

const log = logger('submitter');

export async function askSubmit(db: Db, { postId }: { postId: number }) {
  const post = db.select().from(posts).where(eq(posts.id, postId)).get();
  if (!post?.url || post.submitted) return;
  const clip = db.select().from(clips).where(eq(clips.id, post.clipId)).get()!;
  const moment = db.select().from(moments).where(eq(moments.id, clip.momentId)).get()!;
  const { cfg } = sourceContext(db, moment.sourceId);
  if (!cfg.campaign) return;
  await bark(`Submit now · ${cfg.name} · ${post.platform}`, `Link copied. Paste it in the campaign within 30 minutes: ${post.url}`,
    { url: cfg.campaign.url ?? post.url, copy: post.url, level: 'timeSensitive' });
  log.info(`asked owner to submit post ${postId}`);
}
