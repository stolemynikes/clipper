// Dry-run publish -> submit -> track on a DB copy with a mocked fetch. Nothing leaves this machine; live config, DB and .env stay untouched.
// Usage (from apps/core): node src/scripts/dry-publish.ts [--whop]
import { cpSync, mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('../..', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const DIR = mkdtempSync(join(tmpdir(), 'snip-dry-'));
const { paths } = await import(`file:///${CORE}/src/env.ts`);

// Fake secrets AFTER env.ts loaded .env, so nothing real is ever sent (even to the mock).
for (const k of ['DISCORD_BOT_TOKEN', 'POSTPEER_API_KEY']) delete process.env[k];
Object.assign(process.env, {
  YOUTUBE_CLIENT_ID: 'fake', YOUTUBE_CLIENT_SECRET: 'fake', TIKTOK_CLIENT_KEY: 'fake', TIKTOK_CLIENT_SECRET: 'fake',
  ACCOUNT_9001_TOKEN: 'fake-refresh', ACCOUNT_9002_TOKEN: 'fake-refresh',
  WHOP_CLIENT_ID: 'fake', WHOP_REFRESH_TOKEN: 'fake-refresh', BARK_URL: 'https://bark.invalid', BARK_KEY: 'k',
});
const envBefore = readFileSync(paths.envFile, 'utf8');

// Config copy with youtube + tiktok on; the live settings.yaml stays untouched.
const cfgDir = join(DIR, 'config'), dataDir = join(DIR, 'data');
rmSync(cfgDir, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true });
cpSync(paths.configDir, cfgDir, { recursive: true }); mkdirSync(dataDir, { recursive: true });
const s = join(cfgDir, 'settings.yaml');
writeFileSync(s, readFileSync(s, 'utf8').replace(/^(\s+)(youtube|tiktok): false/gm, '$1$2: true'));
const st = join(cfgDir, 'streamers.yaml');
if (process.argv.includes('--whop')) writeFileSync(st, readFileSync(st, 'utf8').replace(/^(\s+)campaign:\n/gm, '$1campaign:\n$1  whopBountyId: bnty_dry\n'));
const live = join(paths.dataDir, 'clipping.db');
paths.configDir = cfgDir; paths.dataDir = dataDir;

const Database = createRequire(`${CORE}/package.json`)('better-sqlite3');
const src = new Database(live, { readonly: true });
await src.backup(join(dataDir, 'clipping.db')); src.close();

const calls: string[] = [];
const json = (b: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json', ...init.headers }, ...init });
globalThis.fetch = (async (input: any, init: any = {}) => {
  const u = new URL(typeof input === 'string' ? input : input.url), m = init.method ?? 'GET';
  calls.push(`${m} ${u.host}${u.host === 'bark.invalid' ? '/<push>' : u.pathname}`); // no query, no tokens
  const p = u.pathname;
  if (u.host === 'oauth2.googleapis.com' || p.endsWith('/oauth/token/') || p === '/oauth/token') return json({ access_token: 'fake-access', expires_in: 3600 });
  if (u.host === 'www.googleapis.com' && p.startsWith('/upload/youtube')) return json({}, { headers: { location: 'https://upload.mock/yt' } });
  if (u.host === 'upload.mock' && p === '/yt') return json({ id: 'DRYyt1' });
  if (u.host === 'upload.mock' && p === '/tt') return new Response('', { status: 201 });
  if (u.host === 'open.tiktokapis.com' && p.includes('video/init')) return json({ data: { publish_id: 'p1', upload_url: 'https://upload.mock/tt' }, error: { code: 'ok' } });
  if (u.host === 'open.tiktokapis.com' && p.includes('status/fetch')) return json({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [777] }, error: { code: 'ok' } });
  if (u.host === 'open.tiktokapis.com' && p.includes('video/query')) return json({ data: { videos: [{ id: '777', view_count: 50, like_count: 2, share_url: 'https://www.tiktok.com/@me/video/777' }] }, error: { code: 'ok' } });
  if (u.host === 'www.googleapis.com' && p === '/youtube/v3/videos') return json({ items: [{ id: 'DRYyt1', statistics: { viewCount: '123', likeCount: '4' } }] });
  if (u.host === 'api.whop.com' && p === '/api/v1/bounty_submissions') return json({ id: 'sub_dry' }, { status: 201 });
  if (u.host === 'bark.invalid') return json({ code: 200 });
  throw new Error(`dry-run: blocked ${m} ${u.host}`);
}) as typeof fetch;

const { openDb } = await import(`file:///${CORE}/src/db/client.ts`);
const { publishClip } = await import(`file:///${CORE}/src/modules/publisher/publish.ts`);
const { askSubmit } = await import(`file:///${CORE}/src/modules/submitter/submit.ts`);
const { trackOnce } = await import(`file:///${CORE}/src/modules/tracker/track.ts`);
const db = openDb(join(dataDir, 'clipping.db'));
const q = db.$client;

const clip = q.prepare(`select c.id, c.file_path f from clips c order by c.id desc limit 40`).all().find((c: any) => existsSync(c.f));
if (!clip) throw new Error('no clip with a file');
q.prepare(`update clips set status='approved' where id=?`).run(clip.id);
q.prepare(`insert into accounts (id, platform, name) values (9001,'youtube','dry-yt'),(9002,'tiktok','dry-tt')`).run();
console.log(`clip ${clip.id}`);

for (const accountId of [9001, 9002]) await publishClip(db, { clipId: clip.id, accountId });
const rows = () => q.prepare(`select id, account_id a, url, external_id x, submitted s from posts where account_id in (9001,9002)`).all();
console.log('posts', rows());
for (const p of rows() as any[]) await askSubmit(db, { postId: p.id });
await trackOnce(db);
console.log('after track', rows());
console.log('stats', q.prepare(`select post_id, views, likes from stats where post_id in (select id from posts where account_id in (9001,9002))`).all());
console.log('jobs', q.prepare(`select type, payload from jobs where id > (select max(id) - 10 from jobs) and type like 'post.%'`).all());
console.log('calls', calls);
console.log('.env unchanged:', readFileSync(paths.envFile, 'utf8') === envBefore);
q.close();
rmSync(DIR, { recursive: true, force: true });
