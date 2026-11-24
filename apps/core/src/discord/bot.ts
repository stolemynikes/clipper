// Discord control hub: one category per campaign in the owner's own server, through an official bot account (no selfbot).
// Per campaign: information (forum post with the brief), review (clips with Keep/Skip), posted, controls, stats.
// Channel and message ids live in data/discord.json, so a restart edits the same messages instead of posting new ones.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits,
  type ButtonInteraction, type ChatInputCommandInteraction, type ForumChannel, type Guild, type TextChannel,
} from 'discord.js';
import { campaignOpen, type StreamerConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import { paths } from '../env.ts';
import { logger } from '../log.ts';
import { campaignNotes } from '../modules/compliance/campaign-notes.ts';
import { accountWarnings, allStreamers, update } from '../review/campaigns.ts';
import { decide, isPaused, reviewUrl, setPaused, status } from '../review/review.ts';
import { reasons } from '../review/server.ts';
import { accountStats } from '../review/setup.ts';

const log = logger('discord');
const STATE = join(paths.dataDir, 'discord.json');
const MAX_FILE = 10 * 1024 * 1024; // Discord upload limit without Nitro boosts
const TEXT = ['review', 'posted', 'controls', 'stats'] as const;

type Hub = { category: string; information: string; infoThread?: string; controlsMsg?: string; statsMsg?: string } & Partial<Record<(typeof TEXT)[number], string>>;
const load = (): Record<string, Hub> => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const save = (s: Record<string, Hub>) => writeFileSync(STATE, JSON.stringify(s, null, 2));

let client: Client | null = null;
let guild: Guild | null = null;

const usd = (n: number) => `$${n.toFixed(2)}`;
const fit = (s: string) => (s.length > 1900 ? `${s.slice(0, 1900)}…` : s); // message limit is 2,000

/** Forum post text: what the campaign pays, its rules and what to watch for. */
export function infoText(s: StreamerConfig, now = new Date()): string {
  const c = s.campaign!;
  const { facts, warnings } = campaignNotes(c, now);
  const tags = Array.isArray(c.rules?.hashtags) ? (c.rules.hashtags as string[]).join(' ') : '';
  return fit([
    `**${s.name}** · ${campaignOpen(c, now) ? 'open' : 'closed'} · ${s.enabled === false ? 'clips off' : 'clips on'}`,
    ...facts.map((f) => `• ${f}`),
    s.tag ? `• Tag: ${s.tag}` : '', tags ? `• Hashtags: ${tags}` : '',
    ...[...warnings, ...accountWarnings(c)].map((w) => `⚠️ ${w}`),
    c.url ? `\n${c.url}` : '',
  ].filter(Boolean).join('\n'));
}

/** Stats text per campaign: posts, views and money earned per account. Pool campaigns show views only (share unknown). */
export function statsText(name: string, rows: ReturnType<typeof accountStats>): string {
  const mine = rows.filter((a) => a.streamer === name);
  if (!mine.some((a) => a.posts)) return `**${name}** · no posts yet`;
  const total = mine.reduce((t, a) => ({ posts: t.posts + a.posts, views: t.views + a.views, earned: t.earned + a.earned }), { posts: 0, views: 0, earned: 0 });
  const pool = mine.some((a) => a.pool);
  return fit([
    `**${name}** · ${total.posts} posts · ${total.views.toLocaleString('en-US')} views · ${pool ? 'pool share (not known yet)' : `${usd(total.earned)} earned`}`,
    ...mine.filter((a) => a.posts).map((a) => `• ${a.platform} ${a.name}: ${a.posts} posts, ${a.views.toLocaleString('en-US')} views${a.pool ? '' : `, ${usd(a.earned)}`}`),
    `_updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC_`,
  ].join('\n'));
}

const controls = (s: StreamerConfig) => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(`clips:${s.name}`).setStyle(s.enabled === false ? ButtonStyle.Success : ButtonStyle.Secondary).setLabel(s.enabled === false ? 'Turn clips on' : 'Turn clips off'),
  new ButtonBuilder().setCustomId('pause').setStyle(isPaused() ? ButtonStyle.Success : ButtonStyle.Danger).setLabel(isPaused() ? 'Resume everything' : 'Pause everything'),
  new ButtonBuilder().setCustomId('refresh').setStyle(ButtonStyle.Secondary).setLabel('Refresh'),
);

const textCh = async (id?: string) => (id ? (await guild!.channels.fetch(id).catch(() => null)) as TextChannel | null : null);

/** Upserts a bot message: edits the saved one, or posts a new one when it is gone. */
async function upsert(ch: TextChannel, id: string | undefined, body: { content: string; components?: ActionRowBuilder<ButtonBuilder>[] }) {
  const old = id ? await ch.messages.fetch(id).catch(() => null) : null;
  return (old ? await old.edit(body) : await ch.send(body)).id;
}

/** Makes sure every campaign has its category and channels, and refreshes the info, controls and stats messages. */
export async function syncDiscord(db: Db) {
  if (!guild) return;
  const state = load(), stats = accountStats(db);
  for (const s of allStreamers().filter((x) => x.campaign)) {
    const hub = state[s.name] ?? ({} as Hub);
    let cat = hub.category ? await guild.channels.fetch(hub.category).catch(() => null) : null;
    if (!cat) cat = await guild.channels.create({ name: s.name, type: ChannelType.GuildCategory });
    hub.category = cat.id;
    let forum = hub.information ? (await guild.channels.fetch(hub.information).catch(() => null)) as ForumChannel | null : null;
    if (!forum) { forum = await guild.channels.create({ name: 'information', type: ChannelType.GuildForum, parent: cat.id }); hub.infoThread = undefined; }
    hub.information = forum.id;
    for (const k of TEXT) if (!(await textCh(hub[k]))) hub[k] = (await guild.channels.create({ name: k, type: ChannelType.GuildText, parent: cat.id })).id;
    state[s.name] = hub;
    save(state); // save ids before posting, so a failed message never makes a second category
    const info = infoText(s);
    const thread = hub.infoThread ? await forum.threads.fetch(hub.infoThread).catch(() => null) : null;
    if (thread) await (await thread.fetchStarterMessage())?.edit(info);
    else hub.infoThread = (await forum.threads.create({ name: `${s.name} campaign`, message: { content: info } })).id;
    hub.controlsMsg = await upsert((await textCh(hub.controls))!, hub.controlsMsg, { content: `**${s.name}** controls`, components: [controls(s)] });
    hub.statsMsg = await upsert((await textCh(hub.stats))!, hub.statsMsg, { content: statsText(s.name, stats) });
    save(state);
  }
}

const reviewButtons = (id: number) => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(`keep:${id}`).setStyle(ButtonStyle.Success).setLabel('Keep ✅'),
  new ButtonBuilder().setCustomId(`skip:${id}`).setStyle(ButtonStyle.Danger).setLabel('Skip ❌'),
);

/** Posts a clip in its campaign's review channel. Returns false when Discord is not set up, so the caller falls back to Bark. */
export async function discordReview(o: { clipId: number; streamer: string; file: string; title: string | null; seconds: number; signals: Record<string, number>; warnings: string[]; autoKept?: boolean }): Promise<boolean> {
  const ch = guild && await textCh(load()[o.streamer]?.review);
  if (!ch) return false;
  const content = fit([
    `**${o.title ?? 'New clip'}** · ${Math.round(o.seconds)}s${o.autoKept ? ' · auto-kept' : ''}`,
    ...reasons(o.signals).map((r) => `• ${r}`), ...o.warnings.map((w) => `⚠️ ${w}`),
    `${reviewUrl()}/#clip-${o.clipId}`,
  ].join('\n'));
  const small = existsSync(o.file) && statSync(o.file).size <= MAX_FILE;
  await ch.send({ content, files: small ? [o.file] : [], components: o.autoKept ? [] : [reviewButtons(o.clipId)] });
  return true;
}

/** Notes a new post in the campaign's posted channel. */
export async function discordPosted(streamer: string, platform: string, url: string | null) {
  const ch = guild && await textCh(load()[streamer]?.posted);
  await ch?.send(`Posted on **${platform}**: ${url ?? 'link comes once the platform has processed it'}`).catch((e) => log.warn('posted message failed', { error: String(e) }));
}

const statusText = (db: Db) => {
  const s = status(db), line = (r: { status: string; n: number }[]) => r.map((x) => `${x.status} ${x.n}`).join(', ') || 'none';
  return `${s.paused ? '⏸️ Paused' : '▶️ Running'}\nJobs: ${line(s.jobs)}\nClips: ${line(s.clips)}`;
};

async function onButton(db: Db, i: ButtonInteraction) {
  const [what, arg] = i.customId.split(':');
  if (what === 'keep' || what === 'skip') {
    const ok = decide(db, Number(arg), what === 'keep');
    return i.update({ content: `${i.message.content}\n\n${ok ? (what === 'keep' ? '✅ Kept: it will be posted' : '❌ Skipped') : 'Already decided'}`, components: [] });
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
  client.on(Events.InteractionCreate, async (i) => {
    if (!i.inGuild() || i.guildId !== guildId || !(i.isButton() || i.isChatInputCommand())) return;
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return void i.reply({ content: 'Only the server owner can do this.', ephemeral: true });
    try { await (i.isButton() ? onButton(db, i) : onCommand(db, i as ChatInputCommandInteraction)); } catch (e) { log.error('interaction failed', { error: String(e) }); }
  });
  client.once(Events.ClientReady, async (c) => {
    guild = await c.guilds.fetch(guildId);
    const perm = PermissionFlagsBits.ManageGuild;
    await guild.commands.set([
      { name: 'pause', description: 'Pause all jobs', defaultMemberPermissions: perm },
      { name: 'resume', description: 'Resume all jobs', defaultMemberPermissions: perm },
      { name: 'status', description: 'Jobs and clips right now', defaultMemberPermissions: perm },
    ]);
    log.info(`Discord ready in ${guild.name}`);
    await syncDiscord(db).catch((e) => log.error('Discord sync failed', { error: String(e) }));
  });
  await client.login(token); // errors carry no token
}

export const stopDiscord = () => client?.destroy();
