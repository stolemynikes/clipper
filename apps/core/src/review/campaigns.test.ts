import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { accountWarnings, expectedPerClip, isGambling, numbersIn, toEntry, unverified, type Extract } from './campaigns.ts';

const brief = `Silky clipping campaign. Earn $1.50 per 1,000 views, max $750 per clip. Budget left: $7.5K.
Clips need 10K views before they pay, min payout $5. Ends Dec 15. Views count on TikTok and YouTube Shorts.
Tag @Silky and use #Silky. Watch twitch.tv/silky.`;
const base: Extract = { name: 'silky', channel: 'silky', tag: '@Silky', ratePer1k: 1.5, maxPerClip: 750, pool: 0, minViews: 10000, totalViews: 0, minPayout: 5,
  budgetLeft: 7500, endsAt: '2026-12-15', platforms: ['tiktok', 'youtube'], hashtags: ['#Silky'], accountNote: '', contentRules: '', disclosure: true, gambling: false };

test('numbers with commas, decimals and K are found', () => {
  const n = numbersIn(brief);
  for (const x of [1.5, 1000, 750, 7500, 10000, 5]) assert.ok(n.has(x), String(x));
});

test('fields that match the brief are verified', () => {
  assert.deepEqual(unverified(base, brief), []);
});

test('made-up numbers, dates and channels are flagged', () => {
  const bad = unverified({ ...base, ratePer1k: 2, maxPerClip: 900, endsAt: '2026-12-20', channel: 'otherguy' }, brief);
  assert.deepEqual(bad.sort(), ['channel', 'endsAt', 'maxPerClip', 'ratePer1k']);
});

test('gambling briefs are caught', () => {
  assert.ok(isGambling('Promote 1WIN casino in your clips'));
  assert.ok(isGambling('stake.com partner stream'));
  assert.ok(isGambling('Betting highlights'));
  assert.ok(!isGambling(brief));
  assert.ok(!isGambling('Fortnite clips, best moments'));
});

test('save rejects gambling and bad input', () => {
  const ok = { name: 'silky', channel: 'silky', ratePer1k: 1.5, maxPerClip: 750, endsAt: '2026-12-15', platforms: ['tiktok'] };
  assert.throws(() => toEntry({ ...ok, brief: 'slots streamer, VAVADA code' }), /Gambling/);
  assert.throws(() => toEntry({ ...ok, gambling: true }), /Gambling/);
  assert.throws(() => toEntry({ ...ok, name: 'bad name!' }), /letters/);
  assert.throws(() => toEntry({ ...ok, platforms: [] }), /platform/);
  assert.throws(() => toEntry({ ...ok, ratePer1k: 0 }), /rate/);
  assert.throws(() => toEntry({ ...ok, url: 'javascript:alert(1)' }), /https/);
  const e = toEntry({ ...ok, hashtags: 'Silky, #clips', minViews: 10000 });
  assert.equal(e.enabled, false);
  assert.equal(e.stage, 'study');
  assert.equal(e.tag, '@silky');
  assert.deepEqual(e.campaign!.rules!.hashtags, ['#Silky', '#clips']);
  assert.equal(e.campaign!.rules!.minViews, 10000);
  assert.equal(e.campaign!.disclosure, true);
});

test('expected $ per clip: rate campaigns use median views and the cap, pools return null', () => {
  const c = { platform: 'content_rewards', ratePer1k: 1.5, maxPerClip: 750, endsAt: '2026-12-15' };
  assert.equal(expectedPerClip(c, 20_000), 30);
  assert.equal(expectedPerClip(c, 1_000_000), 750);
  assert.equal(expectedPerClip(c, undefined), null);
  assert.equal(expectedPerClip({ ...c, ratePer1k: 0, pool: 5000 }, 20_000), null);
});

test('account warnings for Instagram and TikTok', () => {
  const w = accountWarnings({ platform: 'content_rewards', ratePer1k: 1, maxPerClip: 0, endsAt: '2026-12-15',
    rules: { platforms: ['instagram', 'tiktok'], accountNote: 'GTA 6 content only' } });
  assert.equal(w.length, 3);
  assert.match(w[0], /GTA 6/);
});

test('yaml write keeps comments', () => {
  const doc = parseDocument('# owner notes\nstreamers:\n  # main one\n  - name: a\n    enabled: true\n');
  doc.setIn(['streamers', 0, 'enabled'], false);
  (doc.get('streamers') as { add: (n: unknown) => void }).add(doc.createNode({ name: 'b', enabled: false }));
  const out = doc.toString();
  assert.match(out, /# owner notes/);
  assert.match(out, /# main one/);
  assert.match(out, /name: b/);
});

test('toEntry: content rules become per-streamer notes', () => {
  const e = toEntry({ name: 'kai', platforms: 'tiktok', ratePer1k: 1, endsAt: '2099-01-01', contentRules: 'Kai must be the main focus |  no logos | ' });
  assert.deepEqual(e.campaign!.rules!.notes, ['Kai must be the main focus', 'no logos']);
  assert.equal(toEntry({ name: 'kai', platforms: 'tiktok', ratePer1k: 1, endsAt: '2099-01-01' }).campaign!.rules!.notes, undefined);
});
