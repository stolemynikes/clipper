// Renders a piece of the real Twitch chat (colors, badges, 7TV/BTTV/FFZ emotes) as a transparent video,
// so a chat burst in the clip looks exactly like Twitch. TwitchDownloaderCLI does the drawing.
import { join } from 'node:path';
import { paths } from '../../env.ts';
import { runCmd } from '../../proc.ts';

export const CHAT_BOX = { w: 640, h: 420 }; // cam layout: y 1000-1420, clear of the streamer tag at y 1560
const BOTS = 'nightbot,streamelements,streamlabs,moobot,fossabot,wizebot,sery_bot';

export const vodIdOf = (url: string) => url.match(/twitch\.tv\/videos\/(\d+)/)?.[1] ?? null;

/** Chat of VOD seconds [from, to] -> transparent ProRes 4444 file in dir. Messages from 20s earlier fill the box at the start. */
export async function renderTwitchChat(o: { vodId: string; from: number; to: number; dir: string; banWords?: string[] }): Promise<string> {
  const exe = join(paths.toolsDir, 'TwitchDownloaderCLI.exe');
  const tmp = process.env.TEMP ?? o.dir;
  const json = join(o.dir, 'twitch-chat.json'), out = join(o.dir, 'twitch-chat.mov');
  const common = ['--collision', 'Overwrite', '--banner', 'false', '--log-level', 'Error', '--temp-path', tmp];
  await runCmd(exe, ['chatdownload', '--id', o.vodId, '-b', `${Math.max(0, Math.floor(o.from - 20))}s`, '-e', `${Math.ceil(o.to + 1)}s`, '-o', json, '--compression', 'None', ...common]);
  await runCmd(exe, ['chatrender', '-i', json, '-o', out, '-w', String(CHAT_BOX.w), '-h', String(CHAT_BOX.h), '--font-size', '30',
    '--background-color', '#00000000', '--outline', 'true', '--outline-size', '6', '--sub-messages', 'false',
    '--ignore-users', BOTS, ...(o.banWords?.length ? ['--ban-words', o.banWords.join(',')] : []),
    '-b', `${Math.round(o.from * 1000)}ms`, '-e', `${Math.round(o.to * 1000)}ms`, '--framerate', '30',
    '--output-args=-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le "{save_path}"' /* = form: a value starting with - is read as an option */, ...common]);
  return out;
}
