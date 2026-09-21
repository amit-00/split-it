import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, cookieFor, expense, settlement, version } from './helpers.mjs';

async function created(response) {
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  return data;
}

test('durable identity, exact private lookup, missing identity and cross-origin rejection', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  const me = await f.request('alice', '/api/me');
  assert.equal(me.status, 200); assert.equal((await me.json()).user.id, 'alice');
  assert.equal((await f.request(null, '/api/expenses')).status, 401);
  assert.equal((await f.request(null, '/api/me', 'GET', undefined, { Cookie: await cookieFor('missing') })).status, 401);
  assert.equal((await f.request(null, '/api/me', 'GET', undefined, { Cookie: await cookieFor('alice', { appUserId: undefined }) })).status, 401);
  const lookup = await f.request('alice', '/api/users?' + new URLSearchParams({ email: ' BOB@EXAMPLE.COM ' }));
  assert.equal(lookup.status, 200); assert.deepEqual(await lookup.json(), { id: 'bob', name: 'bob', avatarUrl: null });
  assert.equal((await f.request('alice', '/api/users?' + new URLSearchParams({ email: 'bob' }))).status, 400);
  assert.equal((await f.request('alice', '/api/users?' + new URLSearchParams({ email: 'bo@example.com' }))).status, 404);
  await f.db.prepare("INSERT INTO users(id,display_name,email) VALUES('collision','Other','BOB@example.com')").run();
  await f.db.prepare("INSERT INTO user_identities(provider,provider_subject,user_id) VALUES('google','collision-sub','collision')").run();
  assert.equal((await f.request('alice', '/api/users?' + new URLSearchParams({ email: 'bob@example.com' }))).status, 409);
  assert.equal((await f.request('alice', '/api/expenses', 'POST', expense(), { Origin: 'https://evil.example' })).status, 403);
});

test('group owners manage versioned membership; members leave and historical membership can rejoin', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  const g = await created(await f.request('alice', '/api/groups', 'POST', { name: 'Trip', defaultCurrencyCode: 'CAD' }));
  const path = '/api/groups/' + g.id;
  assert.equal((await f.request('bob', path)).status, 404);
  assert.equal((await f.request('alice', path + '/members', 'POST', { userId: 'bob' })).status, 428);
  assert.equal((await f.request('alice', path + '/members', 'POST', { userId: 'bob' }, version(1))).status, 200);
  assert.equal((await f.request('bob', path)).status, 200);
  assert.equal((await f.request('bob', path + '/members', 'POST', { userId: 'carol' }, version(2))).status, 403);
  assert.equal((await f.request('alice', path, 'PATCH', { name: 'Old' }, version(1))).status, 412);
  assert.equal((await f.request('alice', path + '/members/alice', 'DELETE', undefined, version(2))).status, 409);
  assert.equal((await f.request('bob', path + '/members/bob', 'DELETE', undefined, version(2))).status, 200);
  assert.equal((await f.request('bob', path)).status, 404);
  assert.equal((await f.request('alice', path + '/members', 'POST', { userId: 'bob' }, version(3))).status, 200);
  const members = await (await f.request('alice', path + '/members')).json();
  assert.equal(members.items.filter(m => m.userId === 'bob').length, 1);
});

test('expense ownership, balanced allocations, group visibility and detachment preserve debts', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  const e = await created(await f.request('alice', '/api/expenses', 'POST', expense(), { 'Idempotency-Key': 'dinner' }));
  assert.equal(e.version, 1); assert.equal(e.shares.length, 3);
  assert.equal((await f.request('bob', '/api/expenses/' + e.id)).status, 200);
  assert.equal((await f.request('dave', '/api/expenses/' + e.id)).status, 404);
  assert.equal((await f.request('bob', '/api/expenses/' + e.id, 'DELETE', undefined, version(1))).status, 403);
  const balance = await (await f.request('bob', '/api/balances')).json();
  assert.deepEqual(balance.items, [{ userId: 'alice', currencyCode: 'CAD', amountMinor: 1000, direction: 'owedByYou' }]);
  const g = await created(await f.request('alice', '/api/groups', 'POST', { name: 'Trip' }));
  await f.request('alice', '/api/groups/' + g.id + '/members', 'POST', { userId: 'dave' }, version(1));
  const moved = await f.request('alice', '/api/expenses/' + e.id, 'PUT', expense({ groupId: g.id }), version(1));
  assert.equal(moved.status, 200);
  assert.equal((await f.request('dave', '/api/expenses/' + e.id)).status, 200);
  const history = await (await f.request('dave', '/api/expenses/' + e.id + '/history')).json();
  assert.equal(history.items.length, 1); assert.equal(history.items[0].before, null); assert.ok(history.items[0].after);
  assert.equal((await f.request('alice', '/api/groups/' + g.id, 'DELETE', undefined, version(2))).status, 204);
  const detached = await (await f.request('alice', '/api/expenses/' + e.id)).json();
  assert.equal(detached.groupId, null); assert.equal(detached.version, 3);
  assert.equal((await f.request('dave', '/api/expenses/' + e.id)).status, 404);
  assert.deepEqual((await (await f.request('bob', '/api/balances')).json()).items, balance.items);
});

test('idempotent expense creation, stale/concurrent edits, deletion history and no resurrection', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  const create = () => f.request('alice', '/api/expenses', 'POST', expense(), { 'Idempotency-Key': 'same' });
  const results = await Promise.all([create(), create()]);
  const [a, b] = await Promise.all(results.map(created)); assert.equal(a.id, b.id);
  assert.equal((await f.request('alice', '/api/expenses', 'POST', expense({ description: 'Changed' }), { 'Idempotency-Key': 'same' })).status, 409);
  const path = '/api/expenses/' + a.id;
  const edits = await Promise.all(['First', 'Second'].map(description => f.request('alice', path, 'PUT', expense({ description }), version(1))));
  assert.deepEqual(edits.map(r => r.status).sort(), [200, 412]);
  assert.equal((await f.request('alice', path, 'DELETE', undefined, version(1))).status, 412);
  assert.equal((await f.request('alice', path, 'DELETE', undefined, version(2))).status, 204);
  assert.equal((await f.request('bob', path)).status, 404);
  const history = await (await f.request('bob', path + '/history')).json();
  assert.equal(history.items.length, 3); assert.equal(history.items[0].action, 'delete');
  assert.equal((await created(await create())).id, a.id);
  assert.equal((await f.request('alice', path)).status, 404);
  assert.deepEqual((await (await f.request('bob', '/api/balances')).json()).items, []);
});

test('settlements allow overpayment, recorder-only correction and expense changes after payment', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  const e = await created(await f.request('alice', '/api/expenses', 'POST', expense(), { 'Idempotency-Key': 'expense' }));
  const s = await created(await f.request('bob', '/api/settlements', 'POST', settlement(), { 'Idempotency-Key': 'payment' }));
  const path = '/api/settlements/' + s.id;
  assert.deepEqual((await (await f.request('bob', '/api/balances')).json()).items, [{ userId: 'alice', currencyCode: 'CAD', amountMinor: 500, direction: 'owedToYou' }]);
  assert.equal((await f.request('alice', path, 'DELETE', undefined, version(1))).status, 403);
  assert.equal((await f.request('carol', path)).status, 404);
  assert.equal((await f.request('dave', '/api/settlements', 'POST', settlement(), { 'Idempotency-Key': 'forged' })).status, 403);
  assert.equal((await f.request('alice', '/api/expenses/' + e.id, 'DELETE', undefined, version(1))).status, 204);
  assert.deepEqual((await (await f.request('bob', '/api/balances')).json()).items, [{ userId: 'alice', currencyCode: 'CAD', amountMinor: 1500, direction: 'owedToYou' }]);
  assert.equal((await f.request('bob', path, 'PUT', settlement({ amountMinor: 1000 }), version(1))).status, 200);
  assert.equal((await f.request('bob', path, 'PUT', settlement({ currencyCode: 'USD' }), version(2))).status, 400);
  assert.equal((await f.request('bob', path, 'DELETE', undefined, version(2))).status, 204);
  assert.deepEqual((await (await f.request('bob', '/api/balances')).json()).items, []);
  assert.equal((await (await f.request('alice', path + '/history')).json()).items.length, 3);
});

test('validation and failed writes cannot leave allocations, debt or audit behind', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  for (const body of [expense({ currencyCode: 'EUR' }), expense({ amountMinor: 1.5 }), expense({ incurredAt: '2050-01-01T00:00:00Z' }), expense({ incurredAt: '2026-01-01' }), expense({ payments: [{ userId: 'alice', amountMinor: 2000 }] }), expense({ split: { type: 'equal', userIds: ['bob', 'bob'] } })]) {
    assert.equal((await f.request('alice', '/api/expenses', 'POST', body, { 'Idempotency-Key': crypto.randomUUID() })).status, 400);
  }
  assert.equal((await f.request('dave', '/api/expenses', 'POST', expense(), { 'Idempotency-Key': 'outsider' })).status, 403);
  const invalid = expense({ split: { type: 'equal', userIds: ['alice', 'unknown'] } });
  assert.equal((await f.request('alice', '/api/expenses', 'POST', invalid, { 'Idempotency-Key': 'invalid' })).status, 400);
  for (const table of ['expenses', 'expense_payments', 'expense_shares', 'expense_allocations', 'audit_events']) {
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM ' + table).first()).n, 0);
  }
});

test('GET users requires one exact email query and replaces the old POST lookup', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  assert.equal((await f.request(null, '/api/users?email=bob%40example.com')).status, 401);
  for (const query of ['', '?email=', '?email=bob%40example.com&email=carol%40example.com', '?email=bob%40example.com&name=Bob']) {
    assert.equal((await f.request('alice', '/api/users' + query)).status, 400);
  }
  await f.db.prepare("UPDATE users SET email='carol+trip@example.com' WHERE id='carol'").run();
  const response = await f.request('alice', '/api/users?' + new URLSearchParams({ email: 'carol+trip@example.com' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).id, 'carol');
  assert.equal((await f.request('alice', '/api/users/lookup', 'POST', { email: 'bob@example.com' })).status, 404);
});
