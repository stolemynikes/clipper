import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const id = () => integer('id').primaryKey({ autoIncrement: true });
const createdAt = () => integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`);
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

export const streamers = sqliteTable('streamers', {
  id: id(),
  name: text('name').notNull(),
  platform: text('platform', { enum: ['twitch', 'kick', 'youtube', 'footage'] }).notNull(),
  channelId: text('channel_id').notNull(),
  config: json<Record<string, unknown>>('config'), // snapshot of streamers.yaml entry
  createdAt: createdAt(),
});

export const campaigns = sqliteTable('campaigns', {
  id: id(),
  platform: text('platform').notNull(), // e.g. content_rewards
  streamerId: integer('streamer_id').references(() => streamers.id),
  ratePer1k: real('rate_per_1k'),
  maxPerClip: real('max_per_clip'),
  pool: real('pool'),
  budgetLeft: real('budget_left'),
  endsAt: integer('ends_at', { mode: 'timestamp_ms' }),
  rules: json<Record<string, unknown>>('rules'),
  status: text('status', { enum: ['active', 'paused', 'ended'] }).notNull().default('active'),
  createdAt: createdAt(),
});

export const sources = sqliteTable('sources', {
  id: id(),
  url: text('url').notNull().unique(),
  streamerId: integer('streamer_id').references(() => streamers.id),
  durationSec: real('duration_sec'),
  status: text('status', { enum: ['new', 'downloading', 'downloaded', 'analyzed', 'done', 'failed'] }).notNull().default('new'),
  createdAt: createdAt(),
});

export const moments = sqliteTable('moments', {
  id: id(),
  sourceId: integer('source_id').notNull().references(() => sources.id),
  startSec: real('start_sec').notNull(),
  endSec: real('end_sec').notNull(),
  score: real('score').notNull(),
  signals: json<Record<string, number>>('signals'),
  status: text('status', { enum: ['candidate', 'rendering', 'rendered', 'skipped'] }).notNull().default('candidate'),
  createdAt: createdAt(),
});

export const clips = sqliteTable('clips', {
  id: id(),
  momentId: integer('moment_id').notNull().references(() => moments.id),
  filePath: text('file_path').notNull(),
  durationSec: real('duration_sec'),
  hook: text('hook'),
  title: text('title'),
  titleStyle: text('title_style'), // A/B test: 'mild' or 'bold' clickbait
  compliance: json<Record<string, unknown>>('compliance'),
  transcript: text('transcript'), // for spotting the same moment twice (re-uploads, overlapping VODs)
  status: text('status', { enum: ['pending_review', 'approved', 'rejected', 'posted', 'practice'] }).notNull().default('pending_review'),
  createdAt: createdAt(),
});

// One row per social account. Linked to a streamer = that streamer's campaign. OAuth refresh token lives in .env (ACCOUNT_<id>_TOKEN), never here.
export const accounts = sqliteTable('accounts', {
  id: id(),
  platform: text('platform', { enum: ['tiktok', 'youtube', 'instagram'] }).notNull(),
  name: text('name').notNull(),
  streamerId: integer('streamer_id').references(() => streamers.id),
  createdAt: createdAt(),
});

export const posts = sqliteTable('posts', {
  id: id(),
  clipId: integer('clip_id').notNull().references(() => clips.id),
  accountId: integer('account_id').notNull().references(() => accounts.id),
  platform: text('platform', { enum: ['tiktok', 'youtube', 'instagram'] }).notNull(),
  url: text('url'),
  externalId: text('external_id'), // YouTube video id; TikTok 'publish:<id>' until the post id is known
  postedAt: integer('posted_at', { mode: 'timestamp_ms' }),
  submitted: integer('submitted', { mode: 'boolean' }).notNull().default(false),
});

export const stats = sqliteTable('stats', {
  id: id(),
  postId: integer('post_id').notNull().references(() => posts.id),
  views: integer('views').notNull(),
  likes: integer('likes'),
  measuredAt: integer('measured_at', { mode: 'timestamp_ms' }).notNull(),
});

export const jobs = sqliteTable(
  'jobs',
  {
    id: id(),
    type: text('type').notNull(),
    payload: json<unknown>('payload').notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    error: text('error'),
    runAt: integer('run_at', { mode: 'timestamp_ms' }).notNull(),
    lockedAt: integer('locked_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => [index('jobs_claim_idx').on(t.status, t.runAt)],
);

// Money a campaign actually paid out (or announced). Estimates from views live in the API; this is the real number.
export const payouts = sqliteTable('payouts', {
  id: id(),
  campaign: text('campaign').notNull(), // streamer name; campaigns live in streamers.yaml
  amount: real('amount').notNull(), // USD
  status: text('status', { enum: ['pending', 'paid'] }).notNull().default('pending'),
  note: text('note'),
  paidAt: integer('paid_at', { mode: 'timestamp_ms' }),
  createdAt: createdAt(),
});
