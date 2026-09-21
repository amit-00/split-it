import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import * as auth from '../src/auth.ts';

test('verified Google subjects map atomically to one durable user independently of email', async t => {
  const f = await fixture(); t.after(() => f.mf.dispose());
  assert.equal(typeof auth.resolveGoogleUser, 'function');
  const profile = { sub: 'new-google-sub', email: 'new@example.com', email_verified: true, name: 'New Person', picture: undefined };
  const ids = await Promise.all([auth.resolveGoogleUser(f.db, profile), auth.resolveGoogleUser(f.db, profile)]);
  assert.equal(ids[0], ids[1]);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email='new@example.com'").first()).n, 1);
  assert.equal(await auth.resolveGoogleUser(f.db, { ...profile, email: 'changed@example.com' }), ids[0]);
  const other = await auth.resolveGoogleUser(f.db, { ...profile, sub: 'other-google-sub', email: 'changed@example.com' });
  assert.notEqual(other, ids[0]);
  await assert.rejects(auth.resolveGoogleUser(f.db, { ...profile, sub: 'unverified', email_verified: false }));
  assert.equal(await f.db.prepare("SELECT user_id FROM user_identities WHERE provider_subject='unverified'").first(), null);
});
