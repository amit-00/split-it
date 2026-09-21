import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuth } from '../src/auth.ts';
import { fixture, origin, secret } from './helpers.mjs';

test('real Google verification issues a stateless cookie for the durable identity', async t => {
  const f = await fixture();
  t.after(() => f.mf.dispose());
  const keys = await generateKeyPair('RS256');
  const publicKey = { ...await exportJWK(keys.publicKey), kid: 'test-google-key', alg: 'RS256', use: 'sig' };
  const fetch = globalThis.fetch;
  let certificateRequests = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      certificateRequests++;
      return Response.json({ keys: [publicKey] });
    }
    return fetch(input, init);
  });
  const auth = () => createAuth({ DB: f.db, BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' });
  const token = (claims, key = keys.privateKey) => new SignJWT({ email: 'oauth@example.com', email_verified: true, name: 'OAuth Person', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).setIssuer('https://accounts.google.com').setAudience('test-client')
    .setSubject(claims.sub ?? 'oauth-google-subject').setIssuedAt().setExpirationTime('5m').sign(key);
  const signIn = async (idToken) => {
    const response = await auth().handler(new Request(origin + '/api/auth/sign-in/social', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'google', idToken: { token: idToken } }),
    }));
    const text = await response.text();
    return { response, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), body: text ? JSON.parse(text) : null };
  };
  const first = await signIn(await token({}));
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.ok(certificateRequests > 0);
  assert.match(first.cookie, /better-auth.session_data=/);
  const durable = await f.db.prepare("SELECT user_id FROM user_identities WHERE provider='google' AND provider_subject='oauth-google-subject'").first();
  assert.ok(durable);
  await t.test('signed session preserves the durable identity across auth instances and Worker requests', async () => {
    const session = await auth().api.getSession({ headers: new Headers({ Cookie: first.cookie }) });
    assert.equal(session.user.appUserId, durable.user_id);
    assert.equal(first.body.user.appUserId, durable.user_id);
    const me = await f.mf.dispatchFetch(origin + '/api/me', { headers: { Cookie: first.cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, durable.user_id);
  });

  await t.test('repeated Google subjects keep the same ID and refresh the durable profile', async () => {
    const repeated = await signIn(await token({ email: 'renamed@example.com', name: 'Renamed Person' }));
    assert.equal(repeated.response.status, 200, JSON.stringify(repeated.body));
    assert.equal(repeated.body.user.appUserId, durable.user_id);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM user_identities WHERE provider_subject='oauth-google-subject'").first()).n, 1);
    assert.deepEqual(await f.db.prepare('SELECT email,display_name FROM users WHERE id=?').bind(durable.user_id).first(), { email: 'renamed@example.com', display_name: 'Renamed Person' });
  });

  await t.test('a caller cannot overwrite appUserId through update-user', async () => {
    const update = await auth().handler(new Request(origin + '/api/auth/update-user', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: first.cookie },
      body: JSON.stringify({ appUserId: 'bob' }),
    }));
    assert.equal(update.status, 400);
    const updatedCookie = update.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const afterUpdate = await auth().api.getSession({ headers: new Headers({ Cookie: updatedCookie || first.cookie }) });
    assert.equal(afterUpdate.user.appUserId, durable.user_id);
    assert.equal((await f.db.prepare('SELECT email FROM users WHERE id=?').bind(durable.user_id).first()).email, 'renamed@example.com');
  });

  await t.test('invalid signatures and unverified emails cannot register or change durable users', async () => {
    const before = (await f.db.prepare('SELECT COUNT(*) AS n FROM users').first()).n;
    const invalidKeys = await generateKeyPair('RS256');
    const invalid = await signIn(await token({ sub: 'invalid-signature-subject' }, invalidKeys.privateKey));
    assert.equal(invalid.response.status, 401);
    const unverified = await signIn(await token({ sub: 'unverified-email-subject', email_verified: false }));
    assert.ok(unverified.response.status >= 400);
    assert.doesNotMatch(unverified.cookie, /better-auth.session_data=/);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM users').first()).n, before);
    assert.equal(await f.db.prepare("SELECT user_id FROM user_identities WHERE provider_subject IN ('invalid-signature-subject','unverified-email-subject')").first(), null);
    assert.equal((await f.db.prepare('SELECT email FROM users WHERE id=?').bind(durable.user_id).first()).email, 'renamed@example.com');
  });
});
