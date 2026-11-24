import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(coreDir, '..', '..');
const envFile = join(rootDir, '.env');
// .env wins over inherited vars, so TEMP/TMP point to E: instead of the Windows default on C:.
if (existsSync(envFile)) Object.assign(process.env, parseEnv(readFileSync(envFile, 'utf8')));

export const paths = {
  rootDir,
  coreDir,
  configDir: join(rootDir, 'config'),
  toolsDir: join(rootDir, 'tools'),
  envFile,
  dataDir: process.env.DATA_DIR || join(rootDir, 'data'),
  pythonBin: process.env.PYTHON_BIN || join(rootDir, '.venv', 'Scripts', 'python.exe'),
};

/** Keys the user must provide; values are never logged. */
export const requiredKeys = ['BARK_URL', 'BARK_KEY', 'REVIEW_HOST', 'REVIEW_URL', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'] as const;
export const optionalKeys = ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_API_KEY', 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI', 'POSTPEER_API_KEY'] as const;
