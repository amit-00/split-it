import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSignature, symmetricEncodeJWT } from 'better-auth/crypto';
import { migrate } from './helpers.mjs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin = 'http://localhost:8787';
// Deliberately synthetic test values; never used to contact Google.
const secret = 'test-only-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
let mf;
const request = (path, options) => mf.dispatchFetch(origin + path, options);
const post = (path, body, headers = {}) => request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
});

async function sessionCookies({ expiresAt = Date.now() + 3600000 } = {}) {
  const now = new Date();
  const token = 'test-session-token';
  const user = {
    id: 'test-user', appUserId: 'test-user', name: 'Test Friend', email: 'friend@example.com', emailVerified: true,
    image: null, createdAt: now, updatedAt: now,
  };
  const session = {
    id: 'test-session', token, userId: user.id, expiresAt: new Date(expiresAt),
    createdAt: now, updatedAt: now, ipAddress: '', userAgent: '',
  };
  const data = await symmetricEncodeJWT({ session, user, updatedAt: Date.now(), version: '1' }, secret, 'better-auth-session', 3600);
  return {
    token: 'better-auth.session_token=' + encodeURIComponent(token + '.' + await makeSignature(token, secret)),
    data: 'better-auth.session_data=' + encodeURIComponent(data),
  };
}

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'split-it',
    modules: true, scriptPath: 'dist/index.js',
    compatibilityDate: '2026-09-12', compatibilityFlags: ['nodejs_compat'],
    bindings: { BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' },
    d1Databases: { DB: 'auth-test' },
    serviceBindings: { ASSETS: () => new Response('Split It') },
  }));
  const db = await mf.getD1Database('DB');
  await migrate(db);
  await db.prepare("INSERT INTO users(id,display_name,email) VALUES('test-user','Test Friend','friend@example.com')").run();
  await db.prepare("INSERT INTO user_identities(provider,provider_subject,user_id) VALUES('google','test-sub','test-user')").run();
});
after(async () => { await mf?.dispose(); });

test('health succeeds without a database and anonymous API requests are denied', async () => {
  assert.deepEqual(await (await request('/api/health')).json(), { ok: true, authConfigured: true });
  assert.equal((await request('/api/me')).status, 401);
  assert.equal((await request('/api/missing')).status, 404);
});

test('Google OAuth uses the configured callback and identity scopes only', async () => {
  const response = await post('/api/auth/sign-in/social', { provider: 'google', callbackURL: '/' });
  assert.equal(response.status, 200);
  const redirect = new URL((await response.json()).url);
  assert.equal(redirect.hostname, 'accounts.google.com');
  assert.equal(redirect.searchParams.get('redirect_uri'), origin + '/api/auth/callback/google');
  assert.deepEqual(new Set(redirect.searchParams.get('scope').split(' ')), new Set(['openid', 'email', 'profile']));
  assert.ok(redirect.searchParams.get('state'));
  assert.ok(response.headers.get('set-cookie'));
});

test('email signup, password login, other providers and cross-origin sign-in are rejected', async () => {
  for (const path of ['sign-up/email', 'sign-in/email']) {
    const response = await post('/api/auth/' + path, { name: 'Test', email: 'test@example.com', password: 'test-password-123' });
    assert.ok(response.status >= 400, path + ' returned ' + response.status);
  }
  assert.ok((await post('/api/auth/sign-in/social', { provider: 'github' })).status >= 400);
  assert.equal((await post('/api/auth/sign-in/social', { provider: 'google' }, { Origin: 'https://untrusted.example' })).status, 403);
});

test('encrypted cookie session authenticates, rejects tampering and expiry, and sign-out clears cookies', async () => {
  const cookies = await sessionCookies();
  const cookie = cookies.token + '; ' + cookies.data;
  const response = await request('/api/me', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.id, 'test-user');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.getSetCookie().some(cookie => cookie.startsWith('better-auth.session_data=')));
  assert.equal((await request('/api/me', { headers: { Cookie: cookies.token } })).status, 401);
  assert.equal((await request('/api/me', { headers: { Cookie: cookies.token + '; ' + cookies.data + 'tampered' } })).status, 401);
  const expired = await sessionCookies({ expiresAt: Date.now() - 1000 });
  assert.equal((await request('/api/me', { headers: { Cookie: expired.token + '; ' + expired.data } })).status, 401);
  const signOut = await post('/api/auth/sign-out', {}, { Cookie: cookie });
  assert.equal(signOut.status, 200);
  const cleared = signOut.headers.getSetCookie().join('\n');
  assert.match(cleared, /better-auth\.session_token=.*Max-Age=0/i);
  assert.match(cleared, /better-auth\.session_data=.*Max-Age=0/i);
  assert.equal((await request('/api/me')).status, 401);
});
