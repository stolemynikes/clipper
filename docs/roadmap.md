# Roadmap (dev, open items)

## Clips
- [ ] Gameplay layout as an option: gameplay fullscreen, small cam in a corner, for moments where the action is in the game. Example render approved as direction; still needs the rule for when to pick it (face_track: gameplay motion high, face small) and captions placed clear of the cam.
- [ ] Length A/B in the Learner: clips are now 10-35s (target 15-35, ~25s typical, short moments may end at 12s). Compare views per length bucket (10-20, 20-30, 30+) like the title-style A/B, then lean `targetSec` to the winner.
- [ ] Cam box: trim overlays glued to the webcam (e.g. the red "Subs Today" bar in moment 87).
- [ ] Check one fully new clip with all Nov 24 changes together (layout, burst chat, shorter trim, website penalty).

## Campaigns
- [ ] Store per-creator campaign facts in the Campaign table: pool or $/1K, max per clip, view bar for a share, min views per clip, budget left, end date, allowed footage, posting platforms. Research in `docs/campaigns.md`.
- [ ] Flag weak campaigns ("high bar, likely little pay"), e.g. a pool with a 500K-view bar.
- [ ] Scout earlier than phase 4: campaigns are monthly ("[November]") or event-based (GTA 6 launch, Streamer Awards) and budgets run out in days. Check new campaigns daily, notify the owner with a draft `streamers.yaml` entry, and keep facecam/tag config ready for streamers who return each month. Check Content Rewards' terms on automated reading first; else a notice with the link only.
- [ ] Add streamers the owner picks from `docs/campaigns.md` to `config/streamers.yaml`.
- [ ] Posting rules per campaign: accepted platforms (e.g. no X for IShowSpeed), audience/country share (e.g. 40% US/UK/CA/AU), account type. Publisher posts only to accepted platforms; Compliance warns on audience rules (Tracker can't check country share yet).

## Dashboard (phase 4)
- [ ] Campaigns tab: running campaigns per program, rate or pool, rules in plain words, end date, budget left; per campaign clips, views, estimated pay; warnings for a nearly empty pool, a campaign ending soon, a clip not submitted. Submit button opens the Whop link (no API).

## Learner (phase 4)
- [ ] Learn from other creators' viewer clips via the Twitch Clips API (analysis only, never reposted). Names to be picked by the owner (e.g. kaicenat, jynxzi, ishowspeed, xqc).

## Done (Nov 24)
- No cam on top when no face is found: whole frame on a blurred background.
- No double cam: layout measured on the kept part only; gameplay crop slides off the own cam overlay.
- Shorter clips: lead 12s, target 15-35s, min 10s; campaign max still caps.
- Websites rank lower: score x0.5 when the content under the cam is a static page.
- Chat box ends at y 1420, clear of the tag at y 1560; chat only shows when chat goes wild.
