# Practice mode: plan and agreements

Agreed with the owner on 2026-11-25. Source of truth when the chat is compacted.

## Goal

Learn overnight how to make better clips, without changing how live clips are made.
Everything learned becomes a **proposal** that the owner approves or rejects in the dashboard.
Nothing is posted or submitted: Snip stays paused (`data/paused`).

## Phases

**Phase 1 (first night):**
- practice mode
- stop button
- self-healing
- `judgeVersion`
- Monitor

**Phase 2:**
- A/B testing
- Report page
- metadata and sound proposals
- freeze the automatic tweaks
- audio judge (option 1)
- pairwise judge (option 2)

## What practice mode does

1. **Pick a VOD.** One VOD 3 to 14 days old, never analyzed before, with the most views first (Helix `view_count`). Only streamers with an active campaign. It picks the next VOD only when no `vod.analyze` or `clip.render` job is queued.
2. **Analyze it** as usual: chat, viewer clips, audio peaks, then the top-N moments.
3. **Render each moment** with the current template. These clips get status `practice`. Phase 2 adds a second render with the proposal.
4. **Judge each clip with gemma4:12b:** speech (with study examples), frames, layout. Phase 2 adds audio and the pairwise judge. There is no Telegram/Bark review notify for practice clips.
5. **Clean up.** Delete the practice clip files and the VOD segments after judging. Study mp4s are deleted after analysis. Only scores, signals and the small frames for the report stay.
6. **Study daily** in practice mode: weekly Shorts plus the campaign study (top viewer clips and top YouTube Shorts per streamer).
7. **Learn.** The learner runs every 6h in practice mode instead of daily.
8. **Stop** when the owner turns off "Oefenen 's nachts" (`data/practice` removed). The running job finishes first.

## What it learns (phase 2: proposals only, live unchanged)

Moments, captions and clip length are judged by A/B. Metadata has no A/B: gemma cannot judge it.

- **Moments:** weights of `laughMax`, `cheerMax`, `speech`, `visual`. A/B.
- **Captions:** words per line, position. A/B.
- **Length:** clip length, seconds before the peak. A/B.
- **Titles and hooks:** style of the most-viewed Shorts.
- **Sound:**
  - Study Shorts with ffmpeg `ebur128` (loudness) and `music_detect.py` (music under the clip).
  - Proposals for music ducking level, dead-air trim threshold and final loudness. A/B.
- **Metadata:**
  - What is learned: hashtags, tags, description layout, title length, post time, like and comment rate of the top Shorts per streamer.
  - Proposals are labeled "from study, not tested". They are measured by real views after posting.
  - A proposal can never remove the campaign's required tags or the disclosure.
  - No misleading hashtags, and no hashtags of other streamers.
- **Freeze:**
  - `learnedWeights()` (weights.ts) and `weeklyInsights()` (weekly.ts: caption `wordsPerChunk`, titles) stop changing live clips automatically.
  - They become proposals too.
- **`judgeVersion`:** every judgment stores it in the signals, so the learner learns per judge version.

## How a proposal is tested (phase 2)

- **One change per proposal.** Never bundle changes.
- **A/B:** the same moment is rendered twice, with the current template and with the proposal. The pairwise judge picks the more fun clip. The A/B order is random every time.
- **Score:** "wins 14 of 20 (70%)", with the uncertainty. At least 20 pairs are needed before a score shows.
- **A/A control:** sometimes the judge compares two identical clips. It should pick each about 50/50. A strong bias means the scores are not trusted, and the report flags it.
- **Calibration:** the owner is asleep, so there is no owner rating set. Claude scores a sample of practice clips and measures how often it agrees with gemma. Below ~65% agreement, A/B scores are not trusted and Claude writes a judge fix proposal for the morning.
- **After approval:** the proposal goes live, and the old version is kept so it can be rolled back. The tracker compares real views before and after, shown at the proposal.

## Report page (phase 2, dashboard)

For each proposal:
- what changes and why
- the win score and its uncertainty
- frames of the old and new versions
- **Goedkeuren** and **Afwijzen** buttons
- after posting: real views

Also on the page:
- A **Kopieer overzicht** button copies a short summary to give to Claude.
- The morning summary moves here later.

## Self-healing (no Claude needed)

- **A VOD fails:** skip it and take the next VOD.
- **3 different VODs fail in a row:** pause 1 hour, then retry once. If it still fails: stop practice and send a Bark alert.
- **Less than 100 GB free on E::** stop practice and send a Bark alert.
- **08:00 morning summary via Bark:** for example "6 VODs, 2 proposals ready, 1 error fixed". It comes from the worker, so it works even if Claude has no tokens. Later it moves to the dashboard.

## Claude supervision (while the session is open and "Claude kijkt mee" is on)

- **Monitor on `data/worker.log`:** wakes Claude on a `failed`/`error` line, or after 30 min without a new line. 15 min cooldown after each alert.
- **Check-ins:**
  - Every 15 min in hour 1.
  - Hourly in hours 2 and 3.
  - Every 3h after that.
  - Back to every 15 min for 1 hour after any error.
- **System errors** (crash, stuck job, Ollama hangs, disk): Claude fixes them at night, restarts the worker and turns practice back on.
- **Judgment errors:** no prompt changes at night. Claude collects the cases into a morning proposal for the owner.
- **Calibration:** Claude scores a sample of clips (see calibration above).
- **`data/off-claude` exists ("Claude kijkt mee" off):** Claude stops check-ins and the Monitor at the next wake-up. Practice keeps running.

## Dashboard switches (Settings)

- **"Oefenen 's nachts":** `data/practice`. This is the stop button.
- **"Claude kijkt mee":** `data/off-claude`.

## Limits (unchanged hard rules)

- Nothing is posted or submitted. No reuploads: downloads are for analysis only and are deleted.
- Only streamers with an active campaign. No gambling.
- Do not touch:
  - Chrome (CR on port 9333; never wn-watcher's 9222)
  - wn-watcher
  - Ollama task bfiqu6o8f
  - protected PIDs: python 10788, 11092, 12324, 12840, 8696, 5356; node 10208
  - claude processes
- Before the night, close unneeded apps: Spotify, CamoStudio, Steam, Xbox app, WhatsApp, PhoneExperienceHost, SnippingTool, SystemSettings, Discord.
- New dependencies need owner permission. Options 3 (PANNs) and 4 (Qwen-VL) only if gemma often errs on sound or image.
- Option 5 (interaction model, ~100+ own posts with views) stays on the backlog (roadmap.md).

## Open checks

- Does Ollama gemma4 accept audio input? (option 1)
- Is Windows sleep off at night? (`powercfg /query`)
- Is `music_detect.py` reliable on short Shorts?
