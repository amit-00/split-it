import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin = 'http://localhost:8787';
// Deliberately synthetic test values; never used to contact Google.
const secret = 'test-only-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
let mf;
let db;
const request = (path, options) => mf.dispatchFetch(origin + path, options);
const post = (path, body, headers = {}) => request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
});
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: "split-it",
    modules: true, scriptPath: 'dist/index.js',
    compatibilityDate: '2026-09-12', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    bindings: { BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' },
    serviceBindings: { ASSETS: () => new Response('Split It') },
  }));
  db = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
    const statements = (await readFile(`migrations/${file}`, 'utf8')).split('--> statement-breakpoint').map(sql => db.prepare(sql.trim()));
    await db.batch(statements);
  }
});
after(async () => { await mf?.dispose(); });

test('health checks migrated D1 and anonymous API requests are denied', async () => {
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
    const response = await post(`/api/auth/${path}`, { name: 'Test', email: 'test@example.com', password: 'test-password-123' });
    assert.ok(response.status >= 400, `${path} returned ${response.status}`);
  }
  assert.ok((await post('/api/auth/sign-in/social', { provider: 'github' })).status >= 400);
  assert.equal((await post('/api/auth/sign-in/social', { provider: 'google' }, { Origin: 'https://untrusted.example' })).status, 403);
});

test('D1 sessions authenticate, expire and are revoked on sign-out', async () => {
  const now = Date.now();
  await db.prepare('INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('test-user','Test Friend','friend@example.com',1,now,now).run();
  const token = 'test-session-token';
  await db.prepare('INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('test-session',token,'test-user',now+3600000,now,now).run();
  const signature = createHmac('sha256', secret).update(token).digest('base64');
  const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
  const response = await request('/api/me', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.id, 'test-user');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/api/me', { headers: { Cookie: cookie + 'tampered' } })).status, 401);
  await db.prepare('UPDATE session SET expires_at = ? WHERE id = ?').bind(now-1000,'test-session').run();
  assert.equal((await request('/api/me', { headers: { Cookie: cookie } })).status, 401);
  await db.prepare('INSERT OR REPLACE INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('test-session',token,'test-user',now+3600000,now,now).run();
  assert.equal((await post('/api/auth/sign-out', {}, { Cookie: cookie })).status, 200);
  assert.equal((await request('/api/me', { headers: { Cookie: cookie } })).status, 401);
  assert.equal(await db.prepare('SELECT id FROM session WHERE id = ?').bind('test-session').first(), null);
});
