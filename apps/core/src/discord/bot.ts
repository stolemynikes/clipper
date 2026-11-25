// Discord control hub in the owner's own server, through an official bot account (no selfbot). Everything lives in forum posts:
// - General: one forum with a pinned "Totals" post (all money, views, clips) and the pause button.
// - Per campaign: a category with one forum. A pinned "Overview" post (brief, stats, buttons) and one post per clip
//   with Keep/Skip, tagged new / kept / skipped / posted so the forum can be filtered.
// Channel, post and message ids live in data/discord.json, so a restart edits the same posts instead of making new ones.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, ContainerBuilder, Events, GatewayIntentBits, MediaGalleryBuilder,
  MediaGalleryItemBuilder, MessageFlags, PermissionFlagsBits, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder,
  type APIEmbed, type ButtonInteraction, type ChatInputCommandInteraction, type ForumChannel, type Guild, type ThreadChannel,
} from 'discord.js';
import { campaignOpen, loadSettings, type StreamerConfig } from '../config.ts';
import { readHardwareConfig } from '../hardware.ts';
import { runCmd } from '../proc.ts';
import { postText } from '../modules/publisher/publish.ts';
import type { Db } from '../db/client.ts';
import { paths } from '../env.ts';
import { logger } from '../log.ts';
import { campaignNotes } from '../modules/compliance/campaign-notes.ts';
import { needsDisclosure } from '../modules/compliance/compliance.ts';
import { accountWarnings, allStreamers, update } from '../review/campaigns.ts';
import { decide, isPaused, reviewUrl, setPaused, status } from '../review/review.ts';
import { reasons } from '../review/server.ts';
import { accountStats } from '../review/setup.ts';

const log = logger('discord');
const STATE = join(paths.dataDir, 'discord.json');
const MAX_FILE = 10 * 1024 * 1024; // Discord upload limit without Nitro boosts
const TAGS = ['new', 'kept', 'skipped', 'posted'] as const;
type Tag = (typeof TAGS)[number];
const OLD = ['information', 'review', 'posted', 'controls', 'stats', 'overview', 'clips'] as const; // earlier layouts, removed on sync

type Hub = { category: string; forum?: string; post?: string; statsMsg?: string } & Partial<Record<(typeof OLD)[number], string>>;
type State = { general?: Hub; hubs: Record<string, Hub>; clips: Record<string, string>; cards?: Record<string, CardData> }; // clips: clip id -> post (thread) id
const load = (): State => {
  const s = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  return s.hubs ? s : { hubs: Object.fromEntries(Object.entries(s).filter(([, v]) => (v as Hub)?.category)) as Record<string, Hub>, clips: {} }; // first layout kept hubs at the top level
};
const save = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2));

let client: Client | null = null;
let guild: Guild | null = null;

const usd = (n: number) => `$${n.toFixed(2)}`;
const num = (n: number) => n.toLocaleString('en-US');
const fit = (s: string) => (s.length > 1900 ? `${s.slice(0, 1900)}…` : s); // message limit is 2,000
const stamp = () => `_updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC_`;

const COLOR = { open: 0x22c55e, closed: 0xef4444, off: 0x64748b, new: 0xf59e0b, kept: 0x22c55e, skipped: 0xef4444, posted: 0x5865f2, info: 0x5865f2 };
const LABELS: [RegExp, string][] = [[/^Each clip needs /, 'Per clip'], [/^Get (?=.* views over all)/, 'Total bar'], [/^Counts on: /, 'Platforms'], [/^Audience: /, 'Audience'], [/^Ends /, 'Ends']];

/** Overview card: what the campaign pays, its rules and what to watch for, as embed fields that read at a glance. */
export function infoEmbed(s: StreamerConfig, now = new Date()): APIEmbed {
  const c = s.campaign!, open = campaignOpen(c, now);
  const { facts, warnings } = campaignNotes(c, now);
  const tags = Array.isArray(c.rules?.hashtags) ? (c.rules.hashtags as string[]).join(' ') : '';
  const fields = facts.map((f, i) => {
    const l = LABELS.find(([re]) => re.test(f));
    return { name: l ? l[1] : i === 0 ? 'Pay' : 'Note', value: l ? f.replace(l[0], '') : f, inline: true };
  });
  if (s.tag) fields.push({ name: 'Tag', value: s.tag, inline: true });
  if (tags) fields.push({ name: 'Hashtags', value: tags, inline: true });
  const warn = [...warnings, ...accountWarnings(c)];
  if (warn.length) fields.push({ name: 'Watch out', value: warn.map((w) => `⚠️ ${w}`).join('\n').slice(0, 1024), inline: false });
  return {
    title: `${s.name} · ${open ? 'open' : 'closed'}`, url: c.url || undefined,
    description: s.enabled === false ? '⏸️ Clips are off for this campaign' : '▶️ Making clips for this campaign',
    color: !open ? COLOR.closed : s.enabled === false ? COLOR.off : COLOR.open, fields: fields.slice(0, 25),
  };
}

/** Stats text per campaign: posts, views and money earned per account. Pool campaigns show views only (share unknown). */
export function statsText(name: string, rows: ReturnType<typeof accountStats>): string {
  const mine = rows.filter((a) => a.streamer === name);
  if (!mine.some((a) => a.posts)) return `**${name}** · no posts yet`;
  const total = mine.reduce((t, a) => ({ posts: t.posts + a.posts, views: t.views + a.views, earned: t.earned + a.earned }), { posts: 0, views: 0, earned: 0 });
  const pool = mine.some((a) => a.pool);
  return fit([
    `**${name}** · ${total.posts} posts · ${num(total.views)} views · ${pool ? 'pool share (not known yet)' : `${usd(total.earned)} earned`}`,
    ...mine.filter((a) => a.posts).map((a) => `• ${a.platform} ${a.name}: ${a.posts} posts, ${num(a.views)} views${a.pool ? '' : `, ${usd(a.earned)}`}`),
    stamp(),
  ].join('\n'));
}

/** Totals over every campaign: money from rate campaigns, views, posts, and clips per status. */
export function totalsText(rows: ReturnType<typeof accountStats>, clipCounts: { status: string; n: number }[], paused: boolean): string {
  const posted = rows.filter((a) => a.posts);
  const sum = (f: (a: (typeof rows)[number]) => number) => posted.reduce((t, a) => t + f(a), 0);
  const per = new Map<string, { posts: number; views: number; earned: number; pool: boolean }>();
  for (const a of posted) {
    const p = per.get(a.streamer ?? '?') ?? { posts: 0, views: 0, earned: 0, pool: false };
    per.set(a.streamer ?? '?', { posts: p.posts + a.posts, views: p.views + a.views, earned: p.earned + a.earned, pool: p.pool || a.pool });
  }
  const clipsBy = Object.fromEntries(clipCounts.map((c) => [c.status, c.n]));
  return fit([
    `**Clipping Hub** · ${paused ? '⏸️ paused' : '▶️ running'}`,
    `💰 ${usd(sum((a) => a.earned))} earned${posted.some((a) => a.pool) ? ' (plus pool shares, not known yet)' : ''}`,
    `👁️ ${num(sum((a) => a.views))} views · 📤 ${sum((a) => a.posts)} posts`,
    `🎬 ${clipCounts.reduce((t, c) => t + c.n, 0)} clips: ${clipsBy.pending_review ?? 0} to review, ${clipsBy.approved ?? 0} kept, ${clipsBy.posted ?? 0} posted, ${clipsBy.rejected ?? 0} skipped`,
    ...(per.size ? ['', '**Per campaign**', ...[...per].sort((a, b) => b[1].earned - a[1].earned || b[1].views - a[1].views)
      .map(([n, p]) => `• ${n}: ${p.posts} posts, ${num(p.views)} views${p.pool ? '' : `, ${usd(p.earned)}`}`)] : []),
    stamp(),
  ].join('\n'));
}

/** Category name: status dot, streamer and what it pays, so the sidebar reads at a glance. */
export function categoryName(s: StreamerConfig, now = new Date()): string {
  const c = s.campaign!;
  const dot = !campaignOpen(c, now) ? '🔴' : s.enabled === false ? '⏸️' : '🟢';
  return `${dot} ${s.name} · ${c.pool ? `$${num(c.pool)} pool` : `$${c.ratePer1k}/1K`}`.slice(0, 100);
}

const pauseButton = () => new ButtonBuilder().setCustomId('pause').setStyle(isPaused() ? ButtonStyle.Success : ButtonStyle.Danger).setLabel(isPaused() ? 'Resume everything' : 'Pause everything');
const row = (...b: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...b);
const controls = (s: StreamerConfig) => row(
  new ButtonBuilder().setCustomId(`clips:${s.name}`).setStyle(s.enabled === false ? ButtonStyle.Success : ButtonStyle.Secondary).setLabel(s.enabled === false ? 'Turn clips on' : 'Turn clips off'),
  pauseButton(),
  new ButtonBuilder().setCustomId('refresh').setStyle(ButtonStyle.Secondary).setLabel('Refresh'),
);

const fetchCh = async <T>(id?: string) => (id && guild ? ((await guild.channels.fetch(id).catch(() => null)) as T | null) : null);
const tagIds = (f: ForumChannel, names: Tag[]) => f.availableTags.filter((t) => names.includes(t.name as Tag)).map((t) => t.id);

type Body = { embeds: APIEmbed[]; components?: ActionRowBuilder<ButtonBuilder>[] };

/** Makes the category and forum of a hub, then upserts its pinned post (starter = head, second message = body with buttons). */
async function syncHub(hub: Hub, catName: string, forumName: string, postName: string, head: APIEmbed, body: Body, tags: boolean, persist: () => void) {
  const g = guild!;
  let cat = await fetchCh<{ id: string; name: string; setName(n: string): Promise<unknown> }>(hub.category);
  if (!cat) cat = await g.channels.create({ name: catName, type: ChannelType.GuildCategory });
  else if (cat.name !== catName) await cat.setName(catName).catch((e) => log.warn('category rename failed', { error: String(e) })); // Discord allows 2 renames per 10 min
  hub.category = cat.id;
  let forum = await fetchCh<ForumChannel>(hub.forum);
  if (!forum) {
    forum = await g.channels.create({ name: forumName, type: ChannelType.GuildForum, parent: cat.id, availableTags: tags ? TAGS.map((name) => ({ name })) : [] });
    hub.post = hub.statsMsg = undefined;
  }
  hub.forum = forum.id;
  for (const k of OLD) { // only channels this bot made for earlier layouts
    if (hub[k]) await (await fetchCh<{ delete(): Promise<unknown> }>(hub[k]))?.delete().catch(() => null);
    delete hub[k];
  }
  persist(); // save ids before posting, so a failed message never makes a second category
  let post = hub.post ? await forum.threads.fetch(hub.post).catch(() => null) : null;
  if (post?.archived) await post.setArchived(false).catch(() => null);
  if (post) await (await post.fetchStarterMessage().catch(() => null))?.edit({ content: '', embeds: [head] });
  else {
    post = await forum.threads.create({ name: postName, message: { embeds: [head] } });
    hub.post = post.id; hub.statsMsg = undefined;
    await post.pin().catch((e) => log.warn('pin failed', { error: String(e) }));
  }
  const old = hub.statsMsg ? await post.messages.fetch(hub.statsMsg).catch(() => null) : null;
  hub.statsMsg = (old ? await old.edit({ content: '', ...body }) : await post.send(body)).id;
  persist();
}

/** Makes sure General and every campaign have their category, forum and pinned post, and refreshes them. */
export async function syncDiscord(db: Db) {
  if (!guild) return;
  const state = load(), stats = accountStats(db), persist = () => save(state);
  state.general ??= {} as Hub;
  await syncHub(state.general, '📊 General', 'general', 'Totals', { title: 'Totals', description: 'Every campaign together. The card below updates by itself.', color: COLOR.info },
    { embeds: [{ description: totalsText(stats, status(db).clips, isPaused()), color: isPaused() ? COLOR.off : COLOR.open }], components: [row(pauseButton(), new ButtonBuilder().setCustomId('refresh').setStyle(ButtonStyle.Secondary).setLabel('Refresh'))] }, false, persist);
  for (const s of allStreamers().filter((x) => x.campaign)) {
    state.hubs[s.name] ??= {} as Hub;
    await syncHub(state.hubs[s.name], categoryName(s), s.name, 'Overview', infoEmbed(s), { embeds: [{ description: statsText(s.name, stats), color: COLOR.info }], components: [controls(s)] }, true, persist);
  }
}

async function setTags(postId: string | undefined, tags: Tag[]) {
  const post = await fetchCh<ThreadChannel>(postId);
  const forum = post?.parent as ForumChannel | null;
  if (post && forum) await post.setAppliedTags(tagIds(forum, tags)).catch((e) => log.warn('tag update failed', { error: String(e) }));
}

const reviewButtons = (id: number, decided: boolean) => row(...[
  ...(decided ? [] : [
    new ButtonBuilder().setCustomId(`keep:${id}`).setStyle(ButtonStyle.Success).setLabel('Keep ✅'),
    new ButtonBuilder().setCustomId(`skip:${id}`).setStyle(ButtonStyle.Danger).setLabel('Skip ❌'),
  ]),
  new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(`${reviewUrl()}/#clip-${id}`).setLabel('Open review page'),
]);

export type CardData = { clipId: number; rating?: number; title: string; hook: string | null; caption: string; seconds: number; why: string[]; warnings: string[]; media?: string };
export type CardStatus = 'new' | 'auto' | 'kept' | 'skipped';
const CARD: Record<CardStatus, [string, number]> = {
  new: ['🟡 Waiting for you', COLOR.new], auto: ['✅ Auto-kept', COLOR.kept], kept: ['✅ Kept · it will be posted', COLOR.kept], skipped: ['❌ Skipped', COLOR.skipped],
};
const grade = (r: number) => (r >= 8 ? 'Strong' : r >= 5 ? 'Good' : 'Weak');

/** Clip card (Components V2): a rounded container tinted by status, with the video inside and the buttons at the bottom. */
export function clipCard(o: CardData, status: CardStatus): ContainerBuilder {
  const [label, color] = CARD[status];
  const text = (t: string) => new TextDisplayBuilder().setContent(t.slice(0, 1900));
  const meta = [o.rating ? `**${o.rating}/10** ${grade(o.rating)}` : null, `${Math.round(o.seconds)}s`, label].filter(Boolean).join('  ·  ');
  const c = new ContainerBuilder().setAccentColor(color)
    .addTextDisplayComponents(text(`## ${o.title}${o.hook ? `\n*${o.hook}*` : ''}`), text(meta));
  if (o.media) c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(o.media)));
  c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large))
    .addTextDisplayComponents(text(`**Caption**\n> ${o.caption}`));
  if (o.why.length) c.addTextDisplayComponents(text(`**Why this moment**\n${o.why.map((r) => `• ${r}`).join('\n')}`));
  if (o.warnings.length) c.addTextDisplayComponents(text(`**Check this**\n${o.warnings.map((w) => `⚠️ ${w}`).join('\n')}`));
  return c.addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(reviewButtons(o.clipId, status !== 'new'));
}

/** Small copy of the clip for Discord's 10MB upload cap: 720p, bitrate fitted to the length. The real clip is untouched. */
async function preview(file: string, seconds: number): Promise<string | null> {
  if (!existsSync(file)) return null;
  if (statSync(file).size <= MAX_FILE) return file;
  const out = join(dirname(file), 'discord.mp4');
  if (existsSync(out) && statSync(out).size <= MAX_FILE) return out;
  const kbps = Math.max(300, Math.min(4000, Math.floor((9 * 8 * 1024) / Math.max(seconds, 1)) - 128)); // 9MB budget, 128k audio
  const nvenc = readHardwareConfig()?.encoder === 'h264_nvenc';
  await runCmd('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=720:-2',
    '-c:v', nvenc ? 'h264_nvenc' : 'libx264', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]);
  return statSync(out).size <= MAX_FILE ? out : null;
}

/** Posts a clip as its own forum post in its campaign. Returns false when Discord is not set up, so the caller falls back to Bark. */
export async function discordReview(o: { clipId: number; streamer: string; file: string; title: string | null; hook: string | null; seconds: number; signals: Record<string, number>; warnings: string[]; autoKept?: boolean; rating?: number }): Promise<boolean> {
  const state = load();
  const forum = await fetchCh<ForumChannel>(state.hubs[o.streamer]?.forum);
  if (!forum) return false;
  const cfg = allStreamers().find((x) => x.name === o.streamer), clip = loadSettings().clip;
  const title = o.title ?? `${o.streamer} moment`;
  const paid = needsDisclosure(cfg?.campaign, clip.disclosure) && clip.disclosureInText;
  const caption = postText('tiktok', { title, streamer: o.streamer, tag: cfg?.tag ?? '', disclosure: paid ? clip.disclosureText : null }).title;
  const video = await preview(o.file, o.seconds).catch((e) => (log.warn('preview failed', { error: String(e) }), null));
  const name = `clip-${o.clipId}.mp4`;
  const card: CardData = { clipId: o.clipId, rating: o.rating, title, hook: o.hook, caption, seconds: o.seconds, why: reasons(o.signals), warnings: o.warnings, media: video ? `attachment://${name}` : undefined };
  const post = await forum.threads.create({
    name: title.slice(0, 95) || `Clip ${o.clipId}`,
    appliedTags: tagIds(forum, [o.autoKept ? 'kept' : 'new']),
    message: { flags: MessageFlags.IsComponentsV2, components: [clipCard(card, o.autoKept ? 'auto' : 'new')], files: video ? [{ attachment: video, name }] : [] },
  });
  (state.cards ??= {})[o.clipId] = card;
  state.clips[o.clipId] = post.id;
  save(state);
  return true;
}

/** Notes a new post under the clip's forum post and tags it posted. */
export async function discordPosted(clipId: number, platform: string, url: string | null) {
  const postId = load().clips[clipId];
  const post = await fetchCh<ThreadChannel>(postId);
  await post?.send({ embeds: [{ description: `📤 Posted on **${platform}**${url ? `\n${url}` : ' · link comes once the platform has processed it'}`, color: COLOR.posted }] }).catch((e) => log.warn('posted message failed', { error: String(e) }));
  await setTags(postId, ['posted']);
}

const statusText = (db: Db) => {
  const s = status(db), line = (r: { status: string; n: number }[]) => r.map((x) => `${x.status} ${x.n}`).join(', ') || 'none';
  return `${s.paused ? '⏸️ Paused' : '▶️ Running'}\nJobs: ${line(s.jobs)}\nClips: ${line(s.clips)}`;
};

async function onButton(db: Db, i: ButtonInteraction) {
  const [what, arg] = i.customId.split(':');
  if (what === 'keep' || what === 'skip') {
    const ok = decide(db, Number(arg), what === 'keep');
    const card = load().cards?.[arg];
    if (!ok) await i.reply({ content: 'Already decided.', ephemeral: true });
    else if (card) await i.update({ components: [clipCard(card, what === 'keep' ? 'kept' : 'skipped')] });
    else await i.update({ components: [] }); // older embed post: just drop the buttons
    if (ok) await setTags(i.channelId, [what === 'keep' ? 'kept' : 'skipped']);
    return syncDiscord(db); // totals change
  }
  if (what === 'clips') {
    const s = allStreamers().find((x) => x.name === arg);
    if (s) update(s.name, { enabled: s.enabled === false });
  } else if (what === 'pause') setPaused(!isPaused());
  await i.deferUpdate();
  await syncDiscord(db);
}

async function onCommand(db: Db, i: ChatInputCommandInteraction) {
  if (i.commandName === 'pause') setPaused(true);
  if (i.commandName === 'resume') setPaused(false);
  await i.reply({ content: statusText(db), ephemeral: true });
}

/** Starts the bot when DISCORD_BOT_TOKEN and DISCORD_GUILD_ID are set. Only members who can manage the server may press buttons. */
export async function startDiscord(db: Db) {
  const token = process.env.DISCORD_BOT_TOKEN, guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) return log.info('Discord not set up (DISCORD_BOT_TOKEN / DISCORD_GUILD_ID)');
  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const setup = async (g: Guild) => {
    guild = g;
    const perm = PermissionFlagsBits.ManageGuild;
    await g.commands.set([
      { name: 'pause', description: 'Pause all jobs', defaultMemberPermissions: perm },
      { name: 'resume', description: 'Resume all jobs', defaultMemberPermissions: perm },
      { name: 'status', description: 'Jobs and clips right now', defaultMemberPermissions: perm },
    ]);
    log.info(`Discord ready in ${g.name}`);
    await syncDiscord(db);
  };
  const fail = (e: unknown) => log.error('Discord setup failed', { error: String(e) });
  client.on(Events.GuildCreate, (g) => { if (g.id === guildId && !guild) setup(g).catch(fail); }); // bot invited while running
  client.on(Events.InteractionCreate, async (i) => {
    if (!i.inGuild() || i.guildId !== guildId || !(i.isButton() || i.isChatInputCommand())) return;
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return void i.reply({ content: 'Only the server owner can do this.', ephemeral: true });
    try { await (i.isButton() ? onButton(db, i) : onCommand(db, i as ChatInputCommandInteraction)); } catch (e) { log.error('interaction failed', { error: String(e) }); }
  });
  client.on(Events.Error, (e) => log.error('Discord error', { error: String(e) }));
  client.once(Events.ClientReady, async (c) => {
    const g = await c.guilds.fetch(guildId).catch(() => null);
    if (!g) return log.warn(`Discord bot is not in the server yet. Invite it: https://discord.com/oauth2/authorize?client_id=${c.application.id}&scope=bot+applications.commands&permissions=326417632272`);
    await setup(g).catch(fail);
  });
  await client.login(token); // errors carry no token
}

export const stopDiscord = () => client?.destroy();
