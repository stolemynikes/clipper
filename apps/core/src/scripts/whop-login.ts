// One-time Whop login (OAuth + PKCE) for the owner's own account, then a check that the token works.
// Official Whop API only (docs.whop.com). Tokens go to .env, never to the console.
// Run: node src/scripts/whop-login.ts          (asks read + submit scope)
//      node src/scripts/whop-login.ts --read   (read scope only, if Whop refuses the submit scope)
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import '../env.ts';
import { saveEnv } from '../review/setup.ts';

const API = 'https://api.whop.com';
const REDIRECT = 'http://localhost:5179/whop/callback';
const id = process.env.WHOP_CLIENT_ID, secret = process.env.WHOP_CLIENT_SECRET;
if (!id || !secret) throw new Error('WHOP_CLIENT_ID / WHOP_CLIENT_SECRET missing in .env');

const scope = process.argv.includes('--read') ? 'openid bounty:basic:read' : 'openid bounty:basic:read bounty:submission:create';
const b64u = (b: Buffer) => b.toString('base64url');
const verifier = b64u(randomBytes(32));
const state = b64u(randomBytes(16));
const auth = new URL(`${API}/oauth/authorize`);
for (const [k, v] of Object.entries({
  response_type: 'code', client_id: id, redirect_uri: REDIRECT, scope, state, nonce: b64u(randomBytes(16)),
  code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
})) auth.searchParams.set(k, v);

async function api(path: string, token: string) {
  const r = await fetch(`${API}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) as any };
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', REDIRECT);
  if (u.pathname !== '/whop/callback') { res.writeHead(404).end(); return; }
  const send = (msg: string) => res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(msg);
  if (u.searchParams.get('state') !== state) return send('State mismatch. Start the login again.');
  const err = u.searchParams.get('error');
  if (err) {
    console.log(`Whop refused: ${err} ${u.searchParams.get('error_description') ?? ''}`.trim());
    console.log(scope.includes('submission') ? 'Retry with --read (read scope only).' : '');
    send(`Whop refused: ${err}. You can close this tab.`); server.close(); return;
  }
  // Client auth style is not pinned down in the docs: try PKCE-only, then secret in body, then HTTP Basic.
  // invalid_client is rejected before the code is used, so the same code stays valid for the next try.
  const base = { grant_type: 'authorization_code', code: u.searchParams.get('code'), redirect_uri: REDIRECT, client_id: id, code_verifier: verifier };
  const tries: [string, Record<string, string>, object][] = [
    ['pkce', {}, base],
    ['body', {}, { ...base, client_secret: secret }],
    ['basic', { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` }, base],
  ];
  let r!: Response, tok: any;
  tries.push(['form', { 'content-type': 'application/x-www-form-urlencoded' }, { ...base, client_secret: secret }]);
  for (const [name, h, body] of tries) {
    const form = name === 'form';
    r = await fetch(`${API}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...h },
      body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    });
    tok = await r.json().catch(() => null);
    console.log(`token (${name}): HTTP ${r.status} ${tok?.access_token ? 'ok' : tok?.error ?? ''}`);
    if (r.ok && tok?.access_token) break;
    if (tok?.error !== 'invalid_client') break;
  }
  if (!r.ok || !tok?.access_token) {
    console.log(`Token exchange failed: HTTP ${r.status} ${tok?.error ?? ''}`); // no body: it may hold token fields
    send('Login failed. See the terminal.'); server.close(); return;
  }
  if (tok.refresh_token) saveEnv('WHOP_REFRESH_TOKEN', tok.refresh_token);
  console.log(`Logged in. Granted scope: ${tok.scope ?? '(not returned)'}. Refresh token saved to .env.`);
  send('Logged in. You can close this tab.');

  // GET /bounties refuses user OAuth tokens ("Apps may not make requests for users"); /users/me proves the token works.
  const me = await api('/users/me', tok.access_token);
  console.log(`GET /users/me: HTTP ${me.status}`);
  server.close();
});
server.listen(5179, 'localhost', () => console.log(`Open this link and allow access:\n${auth}`));
