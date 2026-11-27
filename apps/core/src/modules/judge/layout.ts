// Layout check: the vision LLM compares frames of the rendered clip against the rule presets in config/judge-rules.yaml.
// Each broken rule lowers the 1-10 rating and shows as a plain-sentence warning on the review card (and blocks auto-keep).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { StreamerConfig } from '../../config.ts';
import { paths } from '../../env.ts';

export type Rule = { id: string; penalty: number; check: string };
export const LAYOUT_PREFIX = 'Layout: '; // marks our warnings, so a re-judge replaces them instead of adding twice

const PROCESS = /\b(submit|within \d+ ?(min|hour)|account|payout|views?)\b/i; // brief notes about posting/paying, not about what is in the clip
/** Content notes from the brief ("X must be the main focus", "No logos, no hate clips") as checkable rules. */
export const briefRules = (campaign: StreamerConfig['campaign']): Rule[] => {
  const notes = campaign?.rules?.notes;
  return (Array.isArray(notes) ? notes.map(String) : []).filter((n) => !PROCESS.test(n)).map((check, i) => ({ id: `note-${i + 1}`, penalty: 2, check }));
};

/** base + the campaign's platform preset + the brief's own rules (penalty 1 each) + the brief's content notes (penalty 2). */
export function layoutRules(campaign: StreamerConfig['campaign'], presets: Record<string, Rule[]> = parse(readFileSync(join(paths.configDir, 'judge-rules.yaml'), 'utf8')).presets): Rule[] {
  const preset = campaign ? (campaign.rulePreset ?? 'content-rewards') : null;
  const extra = (campaign?.judgeRules ?? []).map((check, i) => ({ id: `brief-${i + 1}`, penalty: 1, check }));
  return [...presets.base, ...(preset ? presets[preset] ?? [] : []), ...extra, ...briefRules(campaign)];
}

export const layoutPrompt = (rules: Rule[], transcript = '', footage = false) =>
  `These are frames from a vertical 9:16 short made from ${footage ? "a brand's own video: the whole frame on a blurred background, or cropped to the speaker" : 'a stream: webcam panel on top, game or screen below, on a blurred background'}.
Captions, a chat box, an @tag and #AD are added on purpose. Check each rule against the frames${transcript ? ' and what is said' : ''}. A rule about something that is not in the clip passes.
${transcript ? `What is said: "${transcript.slice(0, 1500)}"
` : ''}Rules:
${rules.map((r) => `- ${r.id}: ${r.check}`).join('\n')}
Only list a rule as broken when you clearly see it in a frame.
Return JSON: "broken": list of {"id", "why"} with "why" one short plain sentence a non-technical person understands. Empty list if all is fine.`;

/** Broken rules -> rating penalty and warnings. Unknown ids (LLM made them up) and repeats are dropped. */
export function layoutResult(broken: { id: string; why: string }[], rules: Rule[]): { penalty: number; warnings: string[] } {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const hit = broken.filter((b, i) => byId.has(b.id) && broken.findIndex((x) => x.id === b.id) === i);
  return { penalty: hit.reduce((a, b) => a + byId.get(b.id)!.penalty, 0), warnings: hit.map((b) => `${LAYOUT_PREFIX}${b.why || byId.get(b.id)!.check}`) };
}
