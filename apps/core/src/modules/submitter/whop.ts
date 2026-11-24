// Whop Developer API as the owner (user OAuth token from scripts/whop-login.ts). Official API only.
// Refresh tokens rotate on every use, so the new one is saved to .env before anything else happens.
import '../../env.ts';
import { saveEnv } from '../../review/setup.ts';

const API = 'https://api.whop.com';
let cached: { token: string; until: number } | null = null;

export const hasWhop = () => !!(process.env.WHOP_CLIENT_ID && process.env.WHOP_REFRESH_TOKEN);

export async function whopToken(): Promise<string> {
  if (cached && Date.now() < cached.until) return cached.token;
  const refresh = process.env.WHOP_REFRESH_TOKEN, id = process.env.WHOP_CLIENT_ID;
  if (!refresh || !id) throw new Error('Whop not linked: run scripts/whop-login.ts');
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refresh, client_id: id }),
  });
  const t = await r.json().catch(() => null) as any;
  if (!r.ok || !t?.access_token) throw new Error(`Whop token refresh failed: HTTP ${r.status} ${t?.error ?? ''}`); // never the body
  if (t.refresh_token) saveEnv('WHOP_REFRESH_TOKEN', t.refresh_token);
  cached = { token: t.access_token, until: Date.now() + ((t.expires_in ?? 3600) - 120) * 1000 };
  return t.access_token;
}

/** Calls /api/v1<path>. Errors carry status + Whop's message only, never headers or tokens. */
export async function whopApi(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const r = await fetch(`${API}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${await whopToken()}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) as any };
}
