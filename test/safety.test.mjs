import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, expense, settlement, version } from './helpers.mjs';

async function create(f, path, body, actor = 'alice', key = crypto.randomUUID()) {
  const response = await f.request(actor, path, 'POST', body, { 'Idempotency-Key': key });
  const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data)); return data;
}

test('overflow and late audit failure roll back the entire financial batch', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  const maximum = Number.MAX_SAFE_INTEGER;
  const huge = expense({ amountMinor: maximum, payments: [{ userId: 'alice', amountMinor: maximum }], split: { type: 'exact', shares: [{ userId: 'bob', amountMinor: maximum }] } });
  await create(f, '/api/expenses', huge);
  const extra = expense({ amountMinor: 1, payments: [{ userId: 'alice', amountMinor: 1 }], split: { type: 'exact', shares: [{ userId: 'bob', amountMinor: 1 }] } });
  assert.equal((await f.request('alice', '/api/expenses', 'POST', extra, { 'Idempotency-Key': 'overflow' })).status, 400);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM expenses').first()).n, 1);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM audit_events').first()).n, 1);
  assert.equal((await (await f.request('bob', '/api/balances')).json()).items[0].amountMinor, maximum);
  await f.db.prepare("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'test failure after financial writes'); END;").run();
  const failed = await f.request('bob', '/api/settlements', 'POST', settlement(), { 'Idempotency-Key': 'late-failure' });
  assert.equal(failed.status, 500); assert.doesNotMatch(JSON.stringify(await failed.json()), /test failure|INSERT|SELECT|SQLITE/);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM settlements').first()).n, 0);
  assert.equal((await (await f.request('bob', '/api/balances')).json()).items[0].amountMinor, maximum);
});

test('CAD and USD remain separate and settlement retry does not duplicate or resurrect payment', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  await create(f, '/api/expenses', expense());
  await create(f, '/api/expenses', expense({ currencyCode: 'USD' }));
  const a = await create(f, '/api/settlements', settlement(), 'bob', 'retry');
  const b = await create(f, '/api/settlements', settlement(), 'bob', 'retry'); assert.equal(a.id, b.id);
  assert.deepEqual((await (await f.request('bob', '/api/balances')).json()).items, [
    { userId: 'alice', currencyCode: 'CAD', amountMinor: 500, direction: 'owedToYou' },
    { userId: 'alice', currencyCode: 'USD', amountMinor: 1000, direction: 'owedByYou' },
  ]);
  assert.equal((await f.request('bob', '/api/settlements', 'POST', settlement({ amountMinor: 999 }), { 'Idempotency-Key': 'retry' })).status, 409);
  await f.request('bob', '/api/settlements/' + a.id, 'DELETE', undefined, version(1));
  assert.equal((await create(f, '/api/settlements', settlement(), 'bob', 'retry')).id, a.id);
  assert.equal((await f.request('bob', '/api/settlements/' + a.id)).status, 404);
});

test('removed financial participants only see history snapshots in which they participated', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  const e = await create(f, '/api/expenses', expense());
  const response = await f.request('alice', '/api/expenses/' + e.id, 'PUT', expense({ split: { type: 'equal', userIds: ['alice', 'carol'] } }), version(1));
  assert.equal(response.status, 200);
  assert.equal((await f.request('bob', '/api/expenses/' + e.id)).status, 404);
  const history = await (await f.request('bob', '/api/expenses/' + e.id + '/history')).json();
  assert.equal(history.items.length, 2); assert.equal(history.items[0].after, null); assert.equal(history.items[0].before.version, 1);
  assert.equal((await f.request('dave', '/api/expenses/' + e.id + '/history')).status, 404);
});

test('cursor pagination preserves equal-date records and enforces list scope', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await create(f, '/api/expenses', expense({ description: 'Expense ' + i }))).id);
  const first = await (await f.request('alice', '/api/expenses?limit=2')).json();
  assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const second = await (await f.request('alice', '/api/expenses?limit=2&cursor=' + encodeURIComponent(first.nextCursor))).json();
  assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.items, ...second.items].map(item => item.id).sort(), ids.sort());
  assert.equal((await f.request('bob', '/api/expenses?cursor=' + encodeURIComponent(first.nextCursor))).status, 400);
  assert.equal((await f.request('alice', '/api/settlements?cursor=' + encodeURIComponent(first.nextCursor))).status, 400);
});

test('creator can correct after leaving while group membership cannot reveal global balances or settlements', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  const g = await create(f, '/api/groups', { name: 'Trip' }, 'dave');
  await f.request('dave', '/api/groups/' + g.id + '/members', 'POST', { userId: 'alice' }, version(1));
  const e = await create(f, '/api/expenses', expense({ groupId: g.id }));
  await f.request('alice', '/api/groups/' + g.id + '/members/alice', 'DELETE', undefined, version(2));
  assert.equal((await f.request('alice', '/api/groups/' + g.id + '/expenses')).status, 404);
  assert.equal((await f.request('alice', '/api/expenses/' + e.id, 'PUT', expense({ groupId: g.id, description: 'Correction' }), version(1))).status, 200);
  assert.equal((await f.request('alice', '/api/expenses', 'POST', expense({ groupId: g.id }), { 'Idempotency-Key': 'new' })).status, 404);
  const s = await create(f, '/api/settlements', settlement(), 'bob');
  assert.equal((await f.request('dave', '/api/settlements/' + s.id)).status, 404);
  assert.deepEqual((await (await f.request('dave', '/api/balances')).json()).items, []);
});

test('malformed, oversized, forged-origin and unexpected fields fail at the boundary', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  assert.equal((await f.request('alice', '/api/expenses', 'POST', expense())).status, 400);
  assert.equal((await f.request('alice', '/api/expenses', 'POST', expense({ createdByUserId: 'bob' }), { 'Idempotency-Key': 'forged' })).status, 400);
  assert.equal((await f.request('alice', '/api/expenses', 'POST', expense({ description: 'x'.repeat(70000) }), { 'Idempotency-Key': 'large' })).status, 413);
  assert.equal((await f.request('alice', '/api/groups', 'POST', { name: 'Trip' }, { Origin: '' })).status, 403);
  assert.equal((await f.request('alice', '/api/groups', 'POST', { name: 'Trip' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('alice', '/api/expenses', 'POST', expense({ incurredAt: '2026-02-30T00:00:00Z' }), { 'Idempotency-Key': 'bad-date' })).status, 400);
});

test('corrections validate final balances even when intermediate reversals exceed the safe range', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  const maximum = Number.MAX_SAFE_INTEGER;
  await create(f, '/api/expenses', expense({ amountMinor: maximum, payments: [{ userId: 'alice', amountMinor: maximum }], split: { type: 'exact', shares: [{ userId: 'bob', amountMinor: maximum }] } }));
  const payment = await create(f, '/api/settlements', settlement({ amountMinor: 1 }), 'bob');
  const extra = expense({ amountMinor: 1, payments: [{ userId: 'alice', amountMinor: 1 }], split: { type: 'exact', shares: [{ userId: 'bob', amountMinor: 1 }] } });
  await create(f, '/api/expenses', extra);
  assert.equal((await f.request('bob', '/api/settlements/' + payment.id, 'PUT', settlement({ amountMinor: 1, note: 'Corrected note' }), version(1))).status, 200);
  const reverse = expense({ amountMinor: 1, payments: [{ userId: 'bob', amountMinor: 1 }], split: { type: 'exact', shares: [{ userId: 'alice', amountMinor: 1 }] } });
  const reverseRecord = await create(f, '/api/expenses', reverse, 'bob');
  await create(f, '/api/expenses', extra);
  assert.equal((await f.request('bob', '/api/expenses/' + reverseRecord.id, 'PUT', { ...reverse, description: 'Corrected description' }, version(1))).status, 200);
  assert.equal((await (await f.request('bob', '/api/balances')).json()).items[0].amountMinor, maximum);
  assert.equal((await f.request('bob', '/api/expenses/' + reverseRecord.id, 'DELETE', undefined, version(2))).status, 400);
  assert.equal((await f.request('bob', '/api/expenses/' + reverseRecord.id)).status, 200);
});
