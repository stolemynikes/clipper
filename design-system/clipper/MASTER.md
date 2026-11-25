# Clipper dashboard: design system (master)

Direction: "Carbon studio". Near-black carbon, hairline borders, one electric accent, editorial type.
The clip is the hero of every screen. Picked with UI UX Pro Max (dark OLED + motion-driven, media dashboard),
then tuned after owner feedback ("too unprofessional, want a real carbon dark theme, buttons must match").
Pages in `pages/<name>.md` override this file.

## Audience
Anyone, also people who are not technical. Plain words, reasons instead of scores. One main action per screen.
Every action gives feedback (toast). Mobile first.

## Colors (dark only, neutral carbon: no navy)
| Token | Hex | Use |
|---|---|---|
| bg | #0A0A0B | page |
| surface | #131315 | cards, bars |
| raised | #1C1C1F | buttons, inputs, hover |
| line | rgba(255,255,255,0.08) | hairline borders |
| text | #F4F4F5 | main text |
| muted | #A1A1AA | secondary text (7:1 on surface) |
| accent | #D4FF3A | Keep, active tab, focus ring, live dot (black text on it) |
| warn | #FBBF24 | "Check this" |
| danger | #F87171 | errors |

Never color alone: every status also has an icon and a word.

## Type
- UI and display: Inter Tight (400-700). Display numbers 40-64px, tight tracking (-0.03em).
- Labels, timecodes, counters: JetBrains Mono 11-12px, uppercase, letter-spacing 0.08em.
- Body 15-16px, line-height 1.45. `tabular-nums` on all numbers.

## Components (one size system, no exceptions)
- Button: height 48px (action bar 56px), radius 14px, label 15px/600, icon 18px. Variants: primary (accent bg, black text),
  secondary (raised bg, line border), ghost (no bg). Paired buttons always have equal width.
- Icon button: 48x48, radius 14px, raised bg, always an aria-label.
- Chip: height 28px, radius 999px, mono label.
- Card: surface, 1px line, radius 20px, padding 16px.
- Tab bar: 4 equal columns, 64px + safe area, active = accent icon + 4px accent dot.

## Layout
- Mobile (<768px): bottom tab bar, one column, 16px side padding.
- Desktop: 248px sidebar, clip player center, details panel right (360px).
- Spacing scale 4 / 8 / 12 / 16 / 24 / 32 / 48.

## Motion (Motion library)
- Press: scale 0.97, 120ms. Hover: background to raised, 150ms.
- Page change: fade + 8px rise, 220ms ease-out.
- Lists: stagger 40ms, 280ms each.
- Keep/Skip: card flies out right/left (240ms), next clip scales in from 0.96.
- Counters count up (600ms) on first show. Live dot pulses (2s).
- Loading: skeleton shimmer, never a blank screen.
- `prefers-reduced-motion`: only opacity fades, no count-up, no pulse.

## Icons
Lucide (SVG), stroke 2. No emoji in the UI.

## Checklist before shipping a screen
Contrast 4.5:1, visible focus ring (2px accent), keyboard works, aria-labels on icon buttons, 375/768/1024/1440,
reduced motion, every action has feedback, all buttons from the size system above.
