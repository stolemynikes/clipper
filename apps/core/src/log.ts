import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './env.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
const logDir = join(paths.dataDir, 'logs');
mkdirSync(logDir, { recursive: true });

// Strip any secret value from env that might end up in a message or error.
const secrets = () =>
  Object.entries(process.env)
    .filter(([k, v]) => v && v.length >= 6 && /TOKEN|SECRET|KEY|PASSWORD/.test(k))
    .map(([, v]) => v as string);

export function redact(text: string): string {
  return secrets().reduce((t, s) => t.split(s).join('***'), text);
}

function write(level: Level, scope: string, msg: string, data?: unknown) {
  const t = new Date().toISOString();
  const line = redact(JSON.stringify({ t, level, scope, msg, ...(data !== undefined && { data }) }));
  const day = t.slice(0, 10);
  appendFileSync(join(logDir, `${day}.jsonl`), line + '\n');
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(redact(`[${level}] ${scope}: ${msg}`));
}

export const logger = (scope: string) => ({
  debug: (msg: string, data?: unknown) => write('debug', scope, msg, data),
  info: (msg: string, data?: unknown) => write('info', scope, msg, data),
  warn: (msg: string, data?: unknown) => write('warn', scope, msg, data),
  error: (msg: string, data?: unknown) => write('error', scope, msg, data),
});
