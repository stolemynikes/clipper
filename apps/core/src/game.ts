// Heavy jobs (analyze, render, judge, study, practice) wait while the owner plays, so they don't take GPU and CPU from the game.
// The job that is already running finishes; only new ones wait. Off with settings.gamePause.enabled: false.
import { loadSettings } from './config.ts';
import { logger } from './log.ts';
import { runCmd } from './proc.ts';

const log = logger('game');
// Game folders of the big launchers. The launchers themselves live elsewhere or under \Launcher\ / \Riot Client\.
const GAME_DIR = /\\(steamapps\\common|Epic Games|Riot Games|XboxGames|Ubisoft Game Launcher\\games|EA Games|GOG Galaxy\\Games)\\/i;
const NOT_GAME = /\\(Launcher|Riot Client|Steamworks Shared|_CommonRedist)\\/i;

/** Name of the first running game in "name|path" lines, or null. extra: exe names (no .exe) for games outside those folders. */
export function findGame(lines: string[], extra: string[] = []): string | null {
  const names = new Set(extra.map((n) => n.toLowerCase().replace(/\.exe$/, '')));
  for (const l of lines) {
    const [name, path = ''] = l.trim().split('|');
    if (!name) continue;
    if (names.has(name.toLowerCase()) || (GAME_DIR.test(path) && !NOT_GAME.test(path))) return name;
  }
  return null;
}

let game: string | null = null;
/** The game that is running now (checked every 30 s), or null. */
export const gameRunning = () => game;

async function check() {
  const cfg = loadSettings().gamePause;
  let now: string | null = null;
  if (cfg?.enabled !== false && process.platform === 'win32') {
    const out = await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-Process | Where-Object Path | ForEach-Object { $_.ProcessName + "|" + $_.Path }'], { timeoutMs: 20_000 });
    now = findGame(out.split('\n'), cfg?.processes);
  }
  if (now !== game) log.info(now ? `${now} is running: heavy jobs wait` : 'game closed: heavy jobs continue');
  game = now;
}

export function watchGames(signal: AbortSignal) {
  const tick = () => check().catch((e) => log.warn('game check failed', { error: String(e) }));
  const timer = setInterval(tick, 30_000);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  return tick();
}
