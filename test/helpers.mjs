import { readFile, readdir } from 'node:fs/promises';
import { makeSignature, symmetricEncodeJWT } from 'better-auth/crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export const origin = 'http://localhost:8787';
export const secret = 'test-only-secret-0123456789-abcdefghijklmnopqrstuvwxyz';

export async function migrate(db) {
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).sort()) {
    const sql = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
    let statement = '';
    let trigger = false;
    for (const line of sql.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('PRAGMA ')) continue;
      if (!statement) trigger = trimmed.startsWith('CREATE TRIGGER');
      statement += line + '\n';
      if ((trigger && trimmed === 'END;') || (!trigger && trimmed.endsWith(';'))) {
        await db.prepare(statement).run();
        statement = '';
      }
    }
    if (statement) throw new Error('Unterminated migration: ' + name);
  }
}

export async function cookieFor(id, extra = {}) {
  const now = new Date();
  const token = 'token-' + id;
  const user = { id: 'ephemeral-' + id, appUserId: id, name: id, email: id + '@example.com', emailVerified: true, image: null, createdAt: now, updatedAt: now, ...extra };
  const session = { id: 'session-' + id, token, userId: user.id, expiresAt: new Date(Date.now() + 3600000), createdAt: now, updatedAt: now, ipAddress: '', userAgent: '' };
  const data = await symmetricEncodeJWT({ session, user, updatedAt: Date.now(), version: '1' }, secret, 'better-auth-session', 3600);
  return 'better-auth.session_token=' + encodeURIComponent(token + '.' + await makeSignature(token, secret)) + '; better-auth.session_data=' + encodeURIComponent(data);
}

export async function fixture() {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'api-test', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-09-12', compatibilityFlags: ['nodejs_compat'],
    bindings: { BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' },
    d1Databases: { DB: 'api-test' }, serviceBindings: { ASSETS: () => new Response('Split It') },
  }));
  const db = await mf.getD1Database('DB');
  await migrate(db);
  for (const id of ['alice', 'bob', 'carol', 'dave']) {
    await db.prepare('INSERT INTO users(id,display_name,email) VALUES(?,?,?)').bind(id, id, id + '@example.com').run();
    await db.prepare("INSERT INTO user_identities(provider,provider_subject,user_id) VALUES('google',?,?)").bind('google-' + id, id).run();
  }
  const cookies = Object.fromEntries(await Promise.all(['alice', 'bob', 'carol', 'dave'].map(async id => [id, await cookieFor(id)])));
  const request = (id, path, method = 'GET', body, headers = {}) => mf.dispatchFetch(origin + path, {
    method, headers: { ...(id ? { Cookie: cookies[id] } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { mf, db, request };
}

export const expense = (extra = {}) => ({ description: 'Dinner', currencyCode: 'CAD', amountMinor: 3000, incurredAt: '2026-01-01T00:00:00Z', groupId: null,
  payments: [{ userId: 'alice', amountMinor: 3000 }], split: { type: 'equal', userIds: ['carol', 'alice', 'bob'] }, ...extra });
export const settlement = (extra = {}) => ({ paidByUserId: 'bob', paidToUserId: 'alice', currencyCode: 'CAD', amountMinor: 1500, settledAt: '2026-01-02T00:00:00Z', note: null, ...extra });
export const version = value => ({ 'If-Match': '"' + value + '"' });
