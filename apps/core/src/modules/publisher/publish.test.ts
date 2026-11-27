import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountFits, campaignAllows, kindOf, parsePostUrl, fallbackTitle, nextDay, pickAccounts, politicsBlocked, postText } from './publish.ts';
import { chunk } from '../tracker/track.ts';

test('fallback title: first sentence, capped, no angle brackets', () => {
  assert.equal(fallbackTitle('oh my god he hit the shot. then he left', 'Clix'), 'Oh my god he hit the shot.');
  assert.equal(fallbackTitle('uh', 'Clix'), 'Clix moment');
  assert.equal(fallbackTitle(null, 'Clix'), 'Clix moment');
  const long = fallbackTitle('word '.repeat(40), 'Clix');
  assert.ok(long.length <= 71 && long.endsWith('…'));
  assert.ok(!fallbackTitle('look <script> at this one guys', 'Clix').includes('<'));
});

test('post text carries disclosure and tag on every platform', () => {
  const o = { title: 'He hit the shot', streamer: 'Clix', tag: '@Clix', disclosure: '#ad' };
  const yt = postText('youtube', o);
  assert.equal(yt.title, 'He hit the shot');
  assert.match(yt.description, /^#ad @Clix #Clix #shorts$/);
  assert.equal(postText('tiktok', o).title, 'He hit the shot #ad @Clix #Clix #fyp');
  assert.equal(postText('youtube', { ...o, title: 'x'.repeat(150) }).title.length, 100);
  assert.equal(postText('tiktok', { ...o, hashtags: ['#CLIX', '#ClixClips'] }).title, 'He hit the shot #ad @Clix #CLIX #ClixClips #fyp'); // campaign hashtags required, no duplicates
  assert.doesNotMatch(postText('tiktok', { ...o, disclosure: null }).title, /#ad/);
});

test('daily limit moves the post to tomorrow 10:00', () => {
  const d = nextDay(new Date(2026, 10, 30, 23, 30));
  assert.deepEqual([d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [11, 1, 10, 0]);
});

test('chunk splits for API batch limits', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 20), []);
});

test('handle check only sends valid names to YouTube', async () => {
  const { validHandle } = await import('../../review/setup.ts');
  assert.ok(validHandle('clix.clips.hq') && validHandle('dailyclixclips'));
  assert.ok(!validHandle('ab') && !validHandle('.dot') && !validHandle('a/b') && !validHandle('x'.repeat(31)) && !validHandle('a&key=x'));
});

test('model title is cleaned: one line, no tags, capped; empty throws', async () => {
  const { cleanTitle } = await import('./titles.ts');
  assert.deepEqual(cleanTitle({ title: '"He did NOT\nexpect <this>" #fyp', hook: 'wait for it' }), { title: 'He did NOT expect this fyp', hook: 'wait for it' });
  assert.ok(cleanTitle({ title: 'word '.repeat(30), hook: '' }).title.length <= 71);
  assert.throws(() => cleanTitle({ title: '  ', hook: 'x' }));
});

import { pickIntegration, postBody } from './postpeer.ts';

test('pickIntegration matches name, else the only account on that platform', () => {
  const list = [{ id: 'a', platform: 'tiktok', displayName: '@ClipsNL' }, { id: 'b', platform: 'tiktok', displayName: 'other' }, { id: 'c', platform: 'instagram', displayName: 'x' }];
  assert.equal(pickIntegration(list, 'tiktok', 'clipsnl')?.id, 'a');
  assert.equal(pickIntegration(list, 'tiktok', 'nobody'), undefined); // two tiktok accounts: never guess
  assert.equal(pickIntegration(list, 'instagram', 'nobody')?.id, 'c');
});

test('postBody: public TikTok with paid disclosure, Instagram reel', () => {
  const t = postBody({ platform: 'tiktok', integrationId: 'a', content: 'hi', url: 'u', paid: true, key: 'k' });
  assert.equal(t.platforms[0].platformSpecificData.privacyLevel, 'PUBLIC_TO_EVERYONE');
  assert.equal((t.platforms[0].platformSpecificData as { brandContentToggle: boolean }).brandContentToggle, true);
  assert.equal(t.idempotencyKey, 'k');
  const i = postBody({ platform: 'instagram', integrationId: 'c', content: 'hi', url: 'u', paid: false, key: 'k' });
  assert.deepEqual(i.mediaItems, [{ type: 'video', url: 'u' }]);
});

test('PostPeer stats only at 1, 3 and 7 days', async () => {
  const { statsDue } = await import('./postpeer.ts');
  assert.equal(statsDue(0.5, 0), false);
  assert.equal(statsDue(1.2, 0), true);
  assert.equal(statsDue(2, 1), false);
  assert.equal(statsDue(8, 2), true);
  assert.equal(statsDue(30, 3), false);
});

test('campaign platforms: only listed platforms get posts', () => {
  assert.equal(campaignAllows({ platforms: ['TikTok', 'youtube'] }, 'tiktok'), true);
  assert.equal(campaignAllows({ platforms: ['tiktok', 'youtube'] }, 'instagram'), false);
  assert.equal(campaignAllows({}, 'instagram'), true);
  assert.equal(campaignAllows(undefined, 'youtube'), true);
});

test('pickAccounts: one account per platform per clip, rotates', () => {
  const list = [{ id: 1, platform: 'tiktok' }, { id: 2, platform: 'tiktok' }, { id: 3, platform: 'youtube' }];
  assert.deepEqual(pickAccounts(list, 4).map((a) => a.id), [1, 3]);
  assert.deepEqual(pickAccounts(list, 5).map((a) => a.id), [2, 3]);
  assert.deepEqual(pickAccounts([], 1), []);
});

test('politics blocked on TikTok and X only', () => {
  assert.equal(politicsBlocked('tiktok', 'he talks about Trump again'), true);
  assert.equal(politicsBlocked('x', 'the election is rigged'), true);
  assert.equal(politicsBlocked('youtube', 'he talks about Trump again'), false);
  assert.equal(politicsBlocked('tiktok', 'he trumped the boss fight'), false);
});

test('study hashtags go after the required tags and never duplicate them', () => {
  const o = { title: 'He hit the shot', streamer: 'Clix', tag: '@Clix', disclosure: '#ad', extra: ['#gaming', '#CLIX'] };
  assert.equal(postText('tiktok', o).title, 'He hit the shot #ad @Clix #Clix #fyp #gaming');
});

test('parsePostUrl: pasted links give the id the tracker needs, other sites are refused', () => {
  assert.deepEqual(parsePostUrl('youtube', ' https://youtube.com/shorts/abcDEF12345?feature=share '), { url: 'https://youtube.com/shorts/abcDEF12345?feature=share', externalId: 'abcDEF12345' });
  assert.equal(parsePostUrl('youtube', 'https://youtu.be/abcDEF12345')?.externalId, 'abcDEF12345');
  assert.equal(parsePostUrl('youtube', 'https://www.youtube.com/watch?v=abcDEF12345')?.externalId, 'abcDEF12345');
  assert.equal(parsePostUrl('tiktok', 'https://www.tiktok.com/@me/video/7312345678901234567')?.externalId, '7312345678901234567');
  assert.equal(parsePostUrl('tiktok', 'https://vm.tiktok.com/ZMabc/')?.externalId, null); // short link: saved, views not tracked
  assert.equal(parsePostUrl('instagram', 'https://www.instagram.com/reel/Cxyz/')?.externalId, null);
  assert.equal(parsePostUrl('tiktok', 'https://youtube.com/shorts/abcDEF12345'), null);
  assert.equal(parsePostUrl('youtube', 'https://evil.com/?youtube.com'), null);
  assert.equal(parsePostUrl('youtube', 'https://notyoutube.com/shorts/abcDEF12345'), null);
  assert.equal(parsePostUrl('youtube', 'http://youtube.com/shorts/abcDEF12345'), null);
  assert.equal(parsePostUrl('youtube', 'not a link'), null);
});

test('kindOf + accountFits: footage genre picks the niche account, a tied account always fits', () => {
  assert.equal(kindOf({ platform: 'twitch' }), 'streamers');
  assert.equal(kindOf({ platform: 'footage', genre: 'podcast' }), 'talk');
  assert.equal(kindOf({ platform: 'footage', genre: 'show' }), 'talk');
  assert.equal(kindOf({ platform: 'footage' }), 'talk');
  assert.equal(kindOf({ platform: 'footage', genre: 'music' }), 'music');
  assert.equal(kindOf({ platform: 'footage', genre: 'product' }), 'product');
  assert.ok(accountFits({ streamerId: 3, kind: 'music' }, 3, 'streamers'));
  assert.ok(accountFits({ streamerId: null, kind: 'streamers' }, 3, 'streamers'));
  assert.ok(!accountFits({ streamerId: null, kind: 'music' }, 3, 'streamers'));
  assert.ok(!accountFits({ streamerId: 4, kind: 'streamers' }, 3, 'streamers'));
});

test('source line and stream url in the YouTube description', async () => {
  const { streamUrl } = await import('./publish.ts');
  const o = { title: 'x', streamer: 'Clix', tag: '@Clix', disclosure: null, source: 'https://www.twitch.tv/clix' };
  assert.match(postText('youtube', o).description, /^Clip from: https:\/\/www\.twitch\.tv\/clix\n\n@Clix #Clix/);
  assert.doesNotMatch(postText('tiktok', o).title, /Clip from/);
  assert.equal(streamUrl({ platform: 'kick', channel: 'x' }), 'https://kick.com/x');
  assert.equal(streamUrl({ platform: 'youtube', channel: '@pod', genre: 'podcast' }), undefined); // footage gets no link
});

test('title examples lose hashtags and "| Channel" tails', async () => {
  const { titlePrompt } = await import('./titles.ts');
  const p = titlePrompt('he won', 'Clix', 'mild', ['Who is this guy? 🚬 | Gorgc #dota2 #shorts', 'this guy is TOO good #pummelparty']);
  assert.match(p, /"Who is this guy\? 🚬", "this guy is TOO good"/);
  assert.doesNotMatch(p, /Gorgc|#dota2|#pummelparty/);
});
