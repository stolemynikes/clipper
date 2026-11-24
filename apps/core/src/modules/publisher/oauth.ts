// Access tokens from the refresh tokens the Accounts page stored in .env. Tokens stay in memory, never in logs.
import { APPS, type Platform, saveEnv, tokenKey } from '../../review/setup.ts';

const cache = new Map<number, { token: string; until: number }>();

export const hasToken = (accountId: number) => Boolean(process.env[tokenKey(accountId)]);

export async function accessToken(accountId: number, platform: Platform): Promise<string> {
  const hit = cache.get(accountId);
  if (hit && hit.until > Date.now()) return hit.token;
  const app = APPS[platform];
  const refresh = process.env[tokenKey(accountId)];
  const id = process.env[app.idKey], secret = process.env[app.secretKey];
  if (!refresh || !id || !secret) throw new Error(`account ${accountId} is not connected`);
  const r = await fetch(app.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
    [app.idParam]: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }) });
  const tok = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
  if (!r.ok || !tok.access_token) throw new Error(`token refresh failed for account ${accountId}: ${tok.error ?? r.status}. Reconnect it on the Accounts page.`);
  // TikTok rotates refresh tokens: keep the new one or the next refresh fails.
  if (tok.refresh_token && tok.refresh_token !== refresh) saveEnv(tokenKey(accountId), tok.refresh_token);
  cache.set(accountId, { token: tok.access_token, until: Date.now() + ((tok.expires_in ?? 3600) - 120) * 1000 });
  return tok.access_token;
}
