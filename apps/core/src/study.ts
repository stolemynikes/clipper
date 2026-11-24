// npm run study: what works for each campaign streamer, before we render whole VODs.
// Most profitable campaign first, then extra channels we only learn from. Report: data/study/<name>.md
import { activeStreamers, loadSettings } from './config.ts';
import { viewsToPay } from './modules/compliance/campaign-notes.ts';
import { stopWhisper } from './modules/editor/whisper.ts';
import { pay, studyStreamer, type StudyTarget } from './modules/learner/study.ts';

const TOP = Number(process.argv[2] ?? 10);
const camp = activeStreamers().filter((s) => s.platform === 'twitch' && s.campaign)
  .sort((a, b) => viewsToPay(a.campaign!) - viewsToPay(b.campaign!));
const list: StudyTarget[] = [...camp,
  ...(loadSettings().study?.extra ?? []).filter((c) => !camp.some((s) => s.channel === c)).map((c) => ({ name: c, channel: c }))];
console.log(list.map((s) => `${s.name}: ${pay(s)}`).join('\n'));

try {
  for (const s of list) await studyStreamer(s, TOP);
} finally {
  stopWhisper();
}
