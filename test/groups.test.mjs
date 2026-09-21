import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, version } from './helpers.mjs';

test('user lookup allows 30 requests per minute', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());

  const requests = Array.from({ length: 31 }, () => f.request('alice', '/api/users?email=bob%40example.com'));
  const responses = await Promise.all(requests);
  assert.equal(responses.filter(response => response.status === 200).length, 30);
  assert.equal(responses.filter(response => response.status === 429).length, 1);
});

test('concurrent membership additions accept one matching group version', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  const created = await f.request('alice', '/api/groups', 'POST', { name: 'Trip' });
  const group = await created.json();
  assert.equal(created.status, 201, JSON.stringify(group));

  const add = () => f.request('alice', `/api/groups/${group.id}/members`, 'POST', { userId: 'bob' }, version(1));
  const results = await Promise.all([add(), add()]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);

  const members = await (await f.request('alice', `/api/groups/${group.id}/members`)).json();
  assert.equal(members.items.filter(member => member.userId === 'bob').length, 1);
  assert.equal((await (await f.request('alice', `/api/groups/${group.id}`)).json()).version, 2);
});
