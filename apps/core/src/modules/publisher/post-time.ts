// When to post: in the evening of the audience the campaign wants, spread out per account.
// Pure functions, so the timing stays easy to test.

const ZONES: [RegExp, string][] = [
  [/\b(US|USA|UNITED STATES|AMERICA)\b/, 'America/New_York'],
  [/\b(UK|GB|UNITED KINGDOM|BRITAIN|ENGLAND)\b/, 'Europe/London'],
  [/\b(CA|CANADA)\b/, 'America/Toronto'],
  [/\b(AU|AUSTRALIA)\b/, 'Australia/Sydney'],
  [/\b(NZ|NEW ZEALAND)\b/, 'Pacific/Auckland'],
  [/\b(DE|GERMANY|NL|NETHERLANDS|FR|FRANCE|ES|SPAIN|IT|ITALY|EU|EUROPE)\b/, 'Europe/Berlin'],
  [/\b(BR|BRAZIL)\b/, 'America/Sao_Paulo'],
  [/\b(MX|MEXICO)\b/, 'America/Mexico_City'],
  [/\b(IN|INDIA)\b/, 'Asia/Kolkata'],
  [/\b(PH|PHILIPPINES)\b/, 'Asia/Manila'],
];
const DEFAULT_ZONE = 'America/New_York'; // most campaigns pay for US views
export const POST_WINDOW: [number, number] = [17, 22]; // local evening hours: short-video viewing peaks after work/school

/** Time zone of the first region the campaign's audience rule names ("40% of views from US/UK/CA/AU" = US). */
export function audienceZone(audience: unknown): string {
  if (typeof audience !== 'string') return DEFAULT_ZONE;
  const text = audience.toUpperCase();
  const hits = ZONES.map(([re, tz]) => ({ tz, at: text.search(re) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
  return hits[0]?.tz ?? DEFAULT_ZONE;
}

const fmt = new Map<string, Intl.DateTimeFormat>();
const hourIn = (d: Date, tz: string) => {
  if (!fmt.has(tz)) fmt.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }));
  return Number(fmt.get(tz)!.format(d));
};

const STEP = 15 * 60_000;
/** Earliest time at or after `after` inside the local [from, to) hours of `tz` (DST-safe: checks the real local hour). */
export function postSlot(after: Date, tz: string, [from, to] = POST_WINDOW): Date {
  const inWin = (d: Date) => { const h = hourIn(d, tz); return h >= from && h < to; };
  if (inWin(after)) return after;
  for (let t = Math.ceil(after.getTime() / STEP) * STEP, end = t + 2 * 86_400_000; t < end; t += STEP) {
    if (inWin(new Date(t))) return new Date(t);
  }
  return after;
}

/** Next post time for one account: at least gapMin after its last post or queued post, inside the audience's evening. */
export function nextPostAt(now: Date, last: Date | null, tz: string, gapMin: number): Date {
  const after = last && last.getTime() + gapMin * 60_000 > now.getTime() ? new Date(last.getTime() + gapMin * 60_000) : now;
  return postSlot(after, tz);
}
