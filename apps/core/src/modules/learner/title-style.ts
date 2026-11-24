// Learner, title A/B test: compares views of 'mild' vs 'bold' titles and leans toward the winner.
import type { Db } from '../../db/client.ts';
import type { TitleStyle } from '../publisher/titles.ts';

export interface StyleStat { style: TitleStyle; posts: number; median: number }
const MIN_POSTS = 10; // per style, before trusting a difference
const MIN_LIFT = 1.2; // winner needs 20% more median views
const LEAN = 0.8; // keep 20% on the loser so the test keeps running

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0;
};

/** Latest views per post at least 3 days old, grouped by title style. Median, so one viral post does not decide. */
export function styleStats(db: Db, now = new Date()): StyleStat[] {
  const rows = db.$client.prepare(`
    select c.title_style style, (select views from stats st where st.post_id = p.id order by measured_at desc limit 1) views
    from posts p join clips c on c.id = p.clip_id
    where c.title_style is not null and p.posted_at <= ?`).all(now.getTime() - 3 * 86_400_000) as { style: TitleStyle; views: number | null }[];
  return (['mild', 'bold'] as const).map((style) => {
    const v = rows.filter((r) => r.style === style && r.views != null).map((r) => r.views!);
    return { style, posts: v.length, median: median(v) };
  });
}

/** The winner, or null while there is too little data or no clear difference. */
export function styleWinner(s: StyleStat[]): TitleStyle | null {
  const [a, b] = [...s].sort((x, y) => y.median - x.median);
  return a && b && a.posts >= MIN_POSTS && b.posts >= MIN_POSTS && a.median >= b.median * MIN_LIFT && a.median > 0 ? a.style : null;
}

export function pickStyle(s: StyleStat[], rnd = Math.random()): TitleStyle {
  const w = styleWinner(s);
  if (!w) return rnd < 0.5 ? 'mild' : 'bold';
  return rnd < LEAN ? w : w === 'mild' ? 'bold' : 'mild';
}
