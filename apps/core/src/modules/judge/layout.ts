// Layout check: the vision LLM compares frames of the rendered clip against the rule presets in config/judge-rules.yaml.
// Each broken rule lowers the 1-10 rating and shows as a plain-sentence warning on the review card (and blocks auto-keep).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { StreamerConfig } from '../../config.ts';
import { paths } from '../../env.ts';

export type Rule = { id: string; penalty: number; check: string };
export const LAYOUT_PREFIX = 'Layout: '; // marks our warnings, so a re-judge replaces them instead of adding twice

/** base + the campaign's platform preset + the brief's own rules (penalty 1 each). */
export function layoutRules(campaign: StreamerConfig['campaign'], presets: Record<string, Rule[]> = parse(readFileSync(join(paths.configDir, 'judge-rules.yaml'), 'utf8')).presets): Rule[] {
  const preset = campaign ? (campaign.rulePreset ?? 'content-rewards') : null;
  const extra = (campaign?.judgeRules ?? []).map((check, i) => ({ id: `brief-${i + 1}`, penalty: 1, check }));
  return [...presets.base, ...(preset ? presets[preset] ?? [] : []), ...extra];
}

export const layoutPrompt = (rules: Rule[]) =>
  `These are frames from a vertical 9:16 short made from a stream: webcam panel on top, game or screen below, on a blurred background.
Captions, a chat box, an @tag and #AD are added on purpose. Check each rule. A rule about something that is not in the frames passes.
${rules.map((r) => `- ${r.id}: ${r.check}`).join('\n')}
Only list a rule as broken when you clearly see it in a frame.
Return JSON: "broken": list of {"id", "why"} with "why" one short plain sentence a non-technical person understands. Empty list if all is fine.`;

/** Broken rules -> rating penalty and warnings. Unknown ids (LLM made them up) and repeats are dropped. */
export function layoutResult(broken: { id: string; why: string }[], rules: Rule[]): { penalty: number; warnings: string[] } {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const hit = broken.filter((b, i) => byId.has(b.id) && broken.findIndex((x) => x.id === b.id) === i);
  return { penalty: hit.reduce((a, b) => a + byId.get(b.id)!.penalty, 0), warnings: hit.map((b) => `${LAYOUT_PREFIX}${b.why || byId.get(b.id)!.check}`) };
}
