# Layout rules (checklist for the local judge LLM)

Every rule here came from owner feedback on a real clip. The judge checks rendered frames against them;
a clip that breaks one gets a lower rating plus the reason in review. Add a rule each time the owner flags something.

**The judge reads `config/judge-rules.yaml`, not this file.** Presets: `base` (every clip) + a platform preset
(`content-rewards` by default; set `rulePreset` on the campaign) + the brief's own rules (`judgeRules: [..]` on the
campaign in `streamers.yaml`). Rules the code already guarantees (6b, 9, 11) are not sent to the LLM.

## Cam panel (top)
1. The streamer's whole head is visible, with some room above it. A cut forehead or chin is a fail. (clip 69, Nov 2026)
2. Only the webcam shows in the cam panel: no stream overlay, chat strip, alerts, logos or a sliver of the border. (clip 69)
3. The face is not tiny: about 1/5 of the panel width or more. Hands and reactions stay in view.
4. No game footage or HUD inside the cam panel.

## Game panel (bottom)
5. The action or character is in view, not cut at the edge.
6. No duplicate of the webcam inside the game panel, not even a thin strip at the edge. (clip 69, stack layout)
6b. Cam and game form one joined block, centered; the spare blurred space is split evenly above and below.
7. Text pages (browser, tweet, menu) are readable: whole page shown, not cropped mid-line.
7b. No chat list or overlay from the original stream inside the game panel. (clip 80)
7c. The game panel is never mostly empty or black. (clip 64)

## Overlays
8. Twitch chat box: bottom-left; fades in AND out; stays at least ~10 s; never covers captions. (clip 64)
9. Streamer tag and #ad: bottom-right, inside the TikTok safe zone.
10. Captions do not cover a face or the chat box.

## Sound
11. Even loudness between clips; music ducks smoothly, no pumping.
