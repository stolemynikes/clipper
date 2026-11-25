# Roadmap (dev, open items)

## Clips
- [ ] Gameplay layout as an option: gameplay fullscreen, small cam in a corner, for moments where the action is in the game. Example render approved as direction; still needs the rule for when to pick it (face_track: gameplay motion high, face small) and captions placed clear of the cam.
- [ ] Length A/B in the Learner: target is now 12-26s (Nov 24 study: <20s beat the median 54% vs ~33%, but on Twitch clips, not Shorts/TikTok). Compare views of our posts per length bucket (10-20, 20-30, 30+) like the title-style A/B, then lean `targetSec` to the winner.
- [ ] Cam box: trim overlays glued to the webcam (e.g. the red "Subs Today" bar in moment 87).
- [ ] Check one fully new clip with all Nov 24 changes together (layout, burst chat, shorter trim, website penalty).

## Campaigns
- [ ] Store per-creator campaign facts in the Campaign table: pool or $/1K, max per clip, view bar for a share, min views per clip, budget left, end date, allowed footage, posting platforms. Research in `docs/campaigns.md`.
- [x] Flag weak campaigns (Nov 24: Accounts page "Campaigns" section: facts, warnings for a high bar, low rate, ending soon; link to the campaign page).
- [ ] Scout earlier than phase 4: campaigns are monthly ("[November]") or event-based (GTA 6 launch, Streamer Awards) and budgets run out in days. Check new campaigns daily, notify the owner with a draft `streamers.yaml` entry, and keep facecam/tag config ready for streamers who return each month. Check Content Rewards' terms on automated reading first; else a notice with the link only.
- [ ] More payout sources (owner OK Nov 24, after CR runs), in this order:
  1. Get Content Rewards working first (join campaigns, briefs, first posts).
  2. Read the terms of Vyro and Clipping.net (highest rate, ~$3/1K): streamer campaigns, no gambling, automation allowed, fee, disclosure, how to submit and verify views, and whether one post may join several programs (CR 7.11: one campaign per post). If OK: add as a campaign `platform` with its own fee in `campaign-notes.ts`.
  3. Facebook Reels publisher (official Meta Graph API, Page) only once clips are running: highest native CPM (~$2-4/1K).
  4. Native payouts follow from channel size: YouTube YPP (1K subs + 10M Shorts views/90 days; watch the reused-content policy). TikTok CRP needs videos over 1 min, so it clashes with our 12-26s target.
- [ ] Add streamers the owner picks from `docs/campaigns.md` to `config/streamers.yaml`.
- [x] Posting rules per campaign (Nov 24: `rules.platforms` gates the Publisher, `rules.audience` warns in review): accepted platforms (e.g. no X for IShowSpeed), audience/country share (e.g. 40% US/UK/CA/AU), account type. Publisher posts only to accepted platforms; Compliance warns on audience rules (Tracker can't check country share yet).

## Dashboard (phase 4)
- [ ] Caption settings (owner OK Nov 25, backlog): pick style (bold/pop/clean) and move captions up/down in Settings, with a preview frame from a recent clip with real ffmpeg-burned ASS captions. Uses `captionStyle` and `captionShift`. The owner's choice becomes the current version; night A/B proposals compare against it and change nothing without Approve.
- [ ] Layout editor per streamer (owner OK Nov 25, backlog): on a VOD frame, drag the facecam box, the gameplay box and the caption spot; saves to `config/streamers.yaml`. Fixes the lacy chat overlay in the game crop and kaicenat headroom. Open question: fixed caption spot per streamer, or auto away from the face with the owner's spot as base.
- [ ] Later, only if needed: per-clip editor at review (move captions, edit words, trim, re-render). Conflicts with "only ✅/❌ manual".
- [ ] Campaigns tab: running campaigns per program, rate or pool, rules in plain words, end date, budget left; per campaign clips, views, estimated pay; warnings for a nearly empty pool, a campaign ending soon, a clip not submitted. Submit button opens the Whop link (no API).

## Learner (phase 4)
- [ ] Learn from other creators' viewer clips via the Twitch Clips API (analysis only, never reposted). Names to be picked by the owner (e.g. kaicenat, jynxzi, ishowspeed, xqc).

- [ ] Fun-signal eval, next tests (re-run `eval-study.ts` after each, keep only what raises CV AUC; baseline Nov 24: solo 0.53-0.57, CV linear 0.53):
  - Broader label: also download low-view viewer clips per streamer (good vs bad instead of top-10 good vs better). Check disk first.
  - Audio to the LLM judge (gemma4 audio input) instead of transcript only.
  - Pairwise judge: "which of these two clips is more fun", per streamer.
  - Interaction model (pairs / shallow tree) again once own posts have ~100+ view counts; at n=119 pairs overfit (0.48).
  - New model (PANNs, Qwen-VL): only with owner OK (new dependency, disk).

## Done (Nov 24)
- No cam on top when no face is found: whole frame on a blurred background.
- No double cam: layout measured on the kept part only; gameplay crop slides off the own cam overlay.
- Shorter clips: lead 12s, target 15-35s, min 10s; campaign max still caps.
- Websites rank lower: score x0.5 when the content under the cam is a static page.
- Chat box ends at y 1420, clear of the tag at y 1560; chat only shows when chat goes wild.
