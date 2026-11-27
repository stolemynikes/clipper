# Judge calibration (night practice)

Claude scores a sample of practice clips blind and compares with gemma4:12b (docs/practice-plan.md).

## 2026-11-25, clips 126-141 (lacy, kaicenat)

**Speech (talk score):** Claude scored the 15 transcripts with speech blind, then compared.
- Within 0.2 of gemma: 14 of 15 (93%). Above the 65% bar: A/B scores are trusted.
- The one miss: #140 ("Oh, she's so hot..."): gemma 0.8, Claude 0.4. Gemma is a bit generous on loud
  reactions without a joke.

**Layout penalty:** -2 or -3 on all 16 clips. Checked frames by eye: the judge is mostly **right**.
- lacy: the stream's own chat overlay sits inside the gameplay crop (top-left of the game panel).
  Checked 2026-11-25 on 4 full frames: the overlay is top-right of the source (x 0.72-0.93, y < 0.18) and
  the center crop catches its left edge.
  Our caption sometimes lands on top of it. This is a crop problem, not a judge problem.
- kaicenat (no cam layout): "top of the head cut off" in several frames.

## Proposals for the owner (morning, not changed at night)

1. **Gameplay crop per streamer without the chat overlay** (lacy): move or narrow the game crop in
   `config/streamers.yaml` so the overlay is outside. Built: A/B proposal `crop-lacy` (`gameCrop`, crop below the
   overlay, zoom 1.2x), tested only on lacy practice clips.
2. **No-cam framing** (kaicenat): keep more headroom when the face tracker centers the face.
   Open: nocam picks a 16:9 window by motion (`best_window` in `workers/face_track.py`), not by the face, so
   `FACE_Y` does not apply. Needs a frame check of the kaicenat clips before a knob is built.
3. **Judge prompt:** keep as is. Optional: ask "is there a joke or surprise?" so loud talk alone scores lower.
4. **Pair judge reasons:** on `captions-lower` the judge sometimes says one edit has "larger" or "smaller"
   captions while both use the same size (only the height differs). The pick may still be fine, but the reason
   is made up. Optional: tell the judge what is the same in both, so the reason names the real difference.

## captions-lower frames (checked 05:40)

The render is correct: captions sit 150 px lower, fully on screen, not behind the tag. The judge prefers the
current height (new 2, old 10 after 12 pairs). That is a valid result, not a bug.

## Night results (08:06, all four proposals at 24 pairs)

| Proposal | New wins | Likely range | A/A check | Read |
|---|---|---|---|---|
| 2 words per line | 11 of 24 (46%) | 28-65% | ok | unclear, keep 3 |
| Captions 150 px lower | 8 of 24 (33%) | 18-53% | ok | leans worse, keep current |
| Style "pop" | 12 of 24 (50%) | 31-69% | **biased** (8 of 10 first) | not trusted |
| Style "clean" | 14 of 24 (58%) | 38-75% | ok | leans better, not proven |

5. **Style "pop" cannot be judged from still frames:** in the frames pop looks almost the same as bold; the
   difference is mostly the word animation. The judge then has nothing to compare and falls back on the first
   clip. Proposal: judge animated styles on a short frame sequence (or skip them in A/B and measure by views).
6. **More pairs for "clean":** 24 pairs cannot separate 58% from 50%. Run it another night (about 60 pairs
   needed for a clear answer at this effect size).

## Audio judge (Nov 25): not viable

gemma4:12b lists `audio` and hears content: on an 8 s study clip it quoted "you think I didn't see this?" and laughter, matching Whisper.
It cannot judge sound quality:
- Pair test (clean vs. the same clip with loud white noise, both orders, plus A/A): it answered "1" all three times.
- Single rating 1-10: clean, light noise and loud noise all scored 8, noise "some".

So the sound proposals (`sound-duck-0.3`, `sound-deadair-2`) stay untested by a judge. Real views after posting decide them.
Audio could still help as a content signal (laughter, shouting) later, not as an A/B judge.

## Open checks (Nov 25)

**Sleep at night:** power plan sleeps and hibernates never on AC (`STANDBYIDLE`/`HIBERNATEIDLE` AC = 0). DC (battery) is 10 min and does not apply to this desktop.

**music_detect.py (YAMNet):** controlled test. A study clip with musicRatio 0 got a synthetic instrumental track (chords + kick) mixed in. Speech is about -31.7 dB mean.

| Music level | musicRatio |
|---|---|
| none | 0.00 |
| about 3 dB under the voice | 0.86 |
| about 11 dB under the voice | 0.19 |
| louder than the voice | 1.00 |

- Instrumental music is caught. Quiet background music lands around MUSIC_WARN (0.15) and stays well under MUSIC_BLOCK (0.5). That fits: it warns and ducks, and does not block.
- Not tested: `vocalRatio` on a real song with vocals (no licensed or CC song on disk). That is the riskier block. Test it once a CC vocal track is available.
- gemma4 is no referee for music: on the 6 highest-musicRatio study clips it said "no music" 5 times.

## Sound and crop measurements (Nov 27)

**sound-duck-0.3:** proof renders on the 7 moments with the most music (913, 914, 920, 923, 925, 934, 147). It was skipped on every one with "no music without speech here". The music in these clips always sits under the streamer's voice, so ducking only the speech-free spans never applies. As built, the proposal cannot change a clip. To be useful, it must duck music under speech too (sidechain), which is a new design.

**sound-deadair-2:** in 1 of the last 12 clips the first word comes after 2 s (4.52 s). Dead air at the start is rare, so the proposal applies to few clips.

**kaicenat gameCrop:** not measured. The streamer has no active campaign, so the proof render stops on the hard rule, and no rendered kaicenat clip is left on disk. Measure once a campaign is active again.
