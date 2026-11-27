// Builds an .ass file: word-by-word captions (active word highlighted), streamer tag, disclosure.
// Style picked via UI UX Pro Max: "Gaming Bold" display font (Russo One), white on thick black
// outline, active word yellow for max contrast on any footage. Positions avoid TikTok/Shorts UI
// (top ~8% header, bottom ~17% captions, right-side buttons).

import type { Overlay } from './chat-overlay.ts';

export interface Word { w: string; s: number; e: number; sp?: number } // sp: speaker from diarize.py

export interface AssOptions {
  words: Word[];
  durationSec: number;
  tag: string;
  disclosure?: string | null; // e.g. "#ad", shown for disclosureSec at the start
  disclosureSec?: number;
  hook?: string | null;
  hookY?: number; // title on screen the whole clip (top Shorts, e.g. 1.6M-view Clix one, keep it up), keeps people from swiping
  captionY?: number; // vertical center of captions in the 1080x1920 frame
  wordsPerChunk?: number; // default from the style
  style?: CaptionStyle;
  censor?: string[]; // word stems to mask in captions (audio is untouched)
  chat?: Overlay[]; // chat messages he reacts to, shown as a card over the content
  chatY?: number; // top of the chat card
  burstY?: number; // top of the burst stack (rows go down 72px each)
}

const WHITE = '&H00FFFFFF';
const YELLOW = '&H0015CCFA'; // #FACC15 in ASS BGR order
const BLACK = '&H00000000';
// Other speakers' lines (main speaker stays white): pink #F472B6, cyan #22D3EE, orange #FB923C.
const SPEAKER = ['&H00B672F4', '&H00EED322', '&H003C92FB'];

export type CaptionStyle = keyof typeof STYLES;
/** Caption presets (fonts in assets/fonts, OFL). Picked per streamer or in settings; the Learner can A/B them.
 * bold: Russo One, yellow active word. pop: Archivo Black, green active word that pops. clean: Anton on a dark box. */
export const STYLES = {
  bold: { font: 'Russo One', size: 84, active: YELLOW, outline: 7, shadow: 3, box: false, per: 3, pop: false },
  pop: { font: 'Archivo Black', size: 78, active: '&H0080DE4A', outline: 8, shadow: 2, box: false, per: 2, pop: true }, // #4ADE80
  clean: { font: 'Anton', size: 96, active: YELLOW, outline: 12, shadow: 0, box: true, per: 3, pop: false },
} as const;
const POP = '\\fscx100\\fscy100\\t(0,70,\\fscx118\\fscy118)\\t(70,160,\\fscx108\\fscy108)';

/** Groups words into caption lines: at most `per` words, and a new line after punctuation or a pause,
 * so a line never joins the end of one sentence to the start of the next ("GOD OH MY"). */
export function chunkWords(words: Word[], per: number): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (cur.length >= per || (prev && (/[.,!?;:]$/.test(prev.w) || w.s - prev.e > 0.6))) { out.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

const ts = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

// ASS treats {} and \ as markup; captions must never inject override tags.
const clean = (t: string) => t.replace(/[{}\\]/g, '').toUpperCase();
// Title like top Shorts: white sentence case, black outline. Emoji dropped: libass draws no colour emoji (they go in the post title).
const hookText = (t: string) => t.replace(/[{}\\]|\p{Extended_Pictographic}|️/gu, '').replace(/\s+/g, ' ').trim();

/** Masks a word whose letters start with a censored stem: "fucking" -> "F******". */
export function censorWord(w: string, stems: string[]): string {
  const bare = w.toLowerCase().replace(/[^a-z]/g, '');
  return stems.some((s) => bare.startsWith(s)) ? w.replace(/(?<=[a-z])[a-z]/gi, '*') : w;
}

export function buildAss(o: AssOptions): string {
  const y = o.captionY ?? 900;
  const st = STYLES[o.style ?? 'bold'] ?? STYLES.bold;
  const per = o.wordsPerChunk ?? st.per;
  const words = o.censor?.length ? o.words.map((x) => ({ ...x, w: censorWord(x.w, o.censor!) })) : o.words;
  const lines: string[] = [];
  const ev = (start: number, end: number, style: string, text: string) =>
    lines.push(`Dialogue: 0,${ts(start)},${ts(end)},${style},,0,0,0,,${text}`);

  const groups = chunkWords(words, per);
  // 2+ speakers: each line in its speaker's colour so viewers follow who talks; the one who talks most stays white.
  const count = new Map<number, number>();
  for (const w of words) if (w.sp != null) count.set(w.sp, (count.get(w.sp) ?? 0) + 1);
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([sp]) => sp);
  const base = (chunk: Word[]) => {
    const r = ranked.length > 1 ? ranked.indexOf(chunk.find((x) => x.sp != null)?.sp ?? ranked[0]) : 0;
    return r > 0 ? SPEAKER[(r - 1) % SPEAKER.length] : WHITE;
  };
  groups.forEach((chunk, g) => {
    const last = chunk[chunk.length - 1];
    // Hold the line until the next one starts, but not over a long pause.
    const chunkEnd = Math.min(groups[g + 1]?.[0].s ?? last.e, last.e + 0.5);
    chunk.forEach((word, j) => {
      const end = j < chunk.length - 1 ? chunk[j + 1].s : chunkEnd;
      if (end <= word.s) return;
      const col = base(chunk);
      const on = `{\\c${st.active}${st.pop ? POP : ''}}`, off = `{\\c${col}${st.pop ? '\\fscx100\\fscy100' : ''}}`;
      const text = (col === WHITE ? '' : `{\\c${col}}`) + chunk.map((x, k) => (k === j ? `${on}${clean(x.w)}${off}` : clean(x.w))).join(' ');
      ev(word.s, end, 'Caption', `{\\pos(540,${y})}${text}`);
    });
  });
  // Chat card: Twitch-like, sender in the caption accent color, short fade (micro-animation).
  for (const c of o.chat ?? []) {
    const text = c.text.replace(/[{}\\]/g, '').split(' ').map((w) => (o.censor?.length ? censorWord(w, o.censor) : w)).join(' ');
    const cy = c.row != null ? (o.burstY ?? o.chatY ?? 1000) + c.row * 72 : (o.chatY ?? 1000);
    ev(c.s, c.e, 'Chat', `{\\pos(60,${cy})\\fad(150,150)}{\\c${YELLOW}}${c.user.replace(/[{}\\]/g, '')}{\\c${WHITE}}  ${text}`);
  }
  if (o.tag) ev(0, o.durationSec, 'Tag', `{\\an3\\pos(1050,1890)}${clean(o.tag).toLowerCase()}`);
  // Hook: black on yellow card, below the top UI safe zone, short pop-in (micro-animation).
  if (o.hook?.trim()) ev(0, o.durationSec, 'Hook', `{\\pos(540,${o.hookY ?? 470})\\fad(0,200)}${hookText(o.hook)}`);
  if (o.disclosure) ev(0, o.disclosureSec ?? 3, 'Disclosure', `{\\an3\\pos(1050,1835)}${clean(o.disclosure)}`);

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${st.font},${st.size},${WHITE},${WHITE},${st.box ? '&H59000000' : BLACK},&H80000000,0,0,0,0,100,100,1,0,${st.box ? 3 : 1},${st.outline},${st.shadow},5,60,60,0,1
Style: Tag,Russo One,44,&H33FFFFFF,${WHITE},${BLACK},&H80000000,0,0,0,0,100,100,1,0,1,3,0,5,60,60,0,1
Style: Chat,Russo One,40,${WHITE},${WHITE},&H33101010,&H33101010,0,0,0,0,100,100,0,0,3,14,0,7,60,160,0,1
Style: Hook,Montserrat,66,${WHITE},${WHITE},${BLACK},&H80000000,-1,0,0,0,100,100,0,0,1,5,2,5,90,90,0,1
Style: Disclosure,Russo One,34,${WHITE},${WHITE},&H99000000,&H99000000,0,0,0,0,100,100,1,0,3,10,0,7,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join('\n')}
`;
}
