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
