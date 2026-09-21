import { Hono } from 'hono';
import {
  body,
  checkVersion,
  commit,
  currency,
  expectedVersion,
  fail,
  fields,
  guard,
  id,
  memberSql,
  page,
  paginated,
  requireMember,
  requireUsers,
  text,
  type Bindings,
  type Page,
} from './api';
import { expenseJsonSql } from './records';

interface GroupRow {
  id: string;
  name: string;
  default_currency_code: 'CAD' | 'USD' | null;
  created_by_user_id: string;
  created_at: number;
  version: number;
}

interface MemberRow {
  user_id: string;
  role: 'owner' | 'member';
  joined_at: number;
  left_at?: number | null;
}

interface Group {
  id: string; name: string; defaultCurrencyCode: 'CAD' | 'USD' | null;
  createdByUserId: string; createdAt: string; version: number;
}
interface Membership { userId: string; role: 'owner' | 'member'; joinedAt: string }

function groupJson(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    defaultCurrencyCode: row.default_currency_code,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    version: row.version,
  };
}

function membershipJson(row: MemberRow): Membership {
  return { userId: row.user_id, role: row.role, joinedAt: new Date(row.joined_at).toISOString() };
}


function numericCursor(p: Page): void {
  if (p.sort !== null && typeof p.sort !== 'number') fail(400, 'invalid_cursor', 'Use a cursor returned by this list endpoint.');
}

async function groupForMember(db: D1Database, groupId: string, userId: string): Promise<GroupRow & { member_role: 'owner' | 'member' }> {
  const row = await db.prepare(`
    SELECT g.*, gm.role AS member_role
    FROM groups g JOIN group_members gm ON gm.group_id=g.id
    WHERE g.id=? AND gm.user_id=? AND gm.left_at IS NULL
  `).bind(groupId, userId).first<GroupRow & { member_role: 'owner' | 'member' }>();
  if (!row) fail(404, 'not_found', 'Group not found.');
  return row;
}

async function groupForOwner(db: D1Database, groupId: string, userId: string): Promise<GroupRow> {
  const row = await groupForMember(db, groupId, userId);
  if (row.created_by_user_id !== userId || row.member_role !== 'owner') fail(403, 'owner_required', 'Only the group owner can do that.');
  return row;
}

function ownerGuard(db: D1Database, groupId: string, userId: string, version: number): [D1PreparedStatement, D1PreparedStatement] {
  const statements = guard(
    db,
    `EXISTS(
      SELECT 1 FROM groups g JOIN group_members gm ON gm.group_id=g.id
      WHERE g.id=? AND g.created_by_user_id=? AND gm.user_id=? AND gm.role='owner' AND gm.left_at IS NULL
    )`,
    [groupId, userId, userId],
    'SELECT version=? FROM groups WHERE id=?',
    [version, groupId],
  );
  return [statements[0], statements[1]];
}

export const groups = new Hono<Bindings>();

groups.get('/users', async c => {
  fields(c.req.query(), ['email']);
  const emails = c.req.queries('email');
  if (!emails || emails.length !== 1) fail(400, 'invalid_email', 'Supply exactly one email query parameter.');
  const email = emails[0].trim();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) fail(400, 'invalid_email', 'email must be a valid email address.');

  const userId = c.get('userId');
  const window = Math.floor(Date.now() / 60_000);
  const limited = await c.env.DB.prepare(`
    INSERT INTO lookup_limits(user_id,window,count) VALUES(?,?,1)
    ON CONFLICT(user_id) DO UPDATE SET
      window=excluded.window,
      count=CASE WHEN lookup_limits.window=excluded.window THEN lookup_limits.count+1 ELSE 1 END
    RETURNING count
  `).bind(userId, window).first<{ count: number }>();
  if (!limited) throw new Error('Lookup rate counter did not return a row.');
  if (limited.count > 30) fail(429, 'rate_limited', 'Too many user lookups. Try again next minute.');

  const matches = await c.env.DB.prepare(`
    SELECT u.id, u.display_name, u.avatar_url
    FROM users u
    WHERE lower(trim(u.email))=lower(?)
      AND EXISTS(SELECT 1 FROM user_identities i WHERE i.user_id=u.id AND i.provider='google')
    ORDER BY u.id LIMIT 2
  `).bind(email).all<{ id: string; display_name: string; avatar_url: string | null }>();
  if (matches.results.length === 0) fail(404, 'not_found', 'No registered user has that email address.');
  if (matches.results.length > 1) fail(409, 'ambiguous_email', 'More than one registered user has that email address.');
  const match = matches.results[0];
  return c.json({ id: match.id, name: match.display_name, avatarUrl: match.avatar_url });
});

groups.get('/groups', async c => {
  const userId = c.get('userId');
  const p = page(c, `groups:${userId}`);
  numericCursor(p);
  const cursor = p.sort === null ? '' : 'AND (g.created_at<? OR (g.created_at=? AND g.id<?))';
  const bindings = p.sort === null ? [userId, p.limit + 1] : [userId, p.sort, p.sort, p.id, p.limit + 1];
  const rows = await c.env.DB.prepare(`
    SELECT g.* FROM groups g JOIN group_members gm ON gm.group_id=g.id
    WHERE gm.user_id=? AND gm.left_at IS NULL ${cursor}
    ORDER BY g.created_at DESC,g.id DESC LIMIT ?
  `).bind(...bindings).all<GroupRow>();
  const items = rows.results.map(groupJson);
  return c.json(paginated<Group>(items, p, item => [Date.parse(item.createdAt), item.id]));
});

groups.post('/groups', async c => {
  const input = await body(c);
  fields(input, ['name', 'defaultCurrencyCode']);
  const name = text(input.name, 'name', 200);
  const defaultCurrencyCode = input.defaultCurrencyCode === undefined || input.defaultCurrencyCode === null
    ? null
    : currency(input.defaultCurrencyCode);
  const userId = c.get('userId');
  const groupId = crypto.randomUUID();
  const now = Date.now();
  await commit(c.env.DB, [
    c.env.DB.prepare('INSERT INTO groups(id,name,default_currency_code,created_by_user_id,created_at) VALUES(?,?,?,?,?)')
      .bind(groupId, name, defaultCurrencyCode, userId, now),
    c.env.DB.prepare("INSERT INTO group_members(group_id,user_id,role,joined_at) VALUES(?,?,'owner',?)")
      .bind(groupId, userId, now),
  ]);
  return c.json(groupJson({ id: groupId, name, default_currency_code: defaultCurrencyCode, created_by_user_id: userId, created_at: now, version: 1 }), 201);
});

groups.get('/groups/:id', async c => {
  return c.json(groupJson(await groupForMember(c.env.DB, id(c.req.param('id')), c.get('userId'))));
});

groups.patch('/groups/:id', async c => {
  const version = expectedVersion(c);
  const input = await body(c);
  fields(input, ['name', 'defaultCurrencyCode']);
  if (input.name === undefined && input.defaultCurrencyCode === undefined) fail(400, 'invalid_input', 'Provide a group field to update.');
  const groupId = id(c.req.param('id'));
  const userId = c.get('userId');
  const current = await groupForOwner(c.env.DB, groupId, userId);
  checkVersion(current.version, version);

  const updates: string[] = [];
  const values: unknown[] = [];
  let name = current.name;
  let defaultCurrencyCode = current.default_currency_code;
  if (input.name !== undefined) {
    name = text(input.name, 'name', 200);
    updates.push('name=?'); values.push(name);
  }
  if (input.defaultCurrencyCode !== undefined) {
    defaultCurrencyCode = input.defaultCurrencyCode === null ? null : currency(input.defaultCurrencyCode);
    updates.push('default_currency_code=?'); values.push(defaultCurrencyCode);
  }
  const [start, end] = ownerGuard(c.env.DB, groupId, userId, version);
  await commit(c.env.DB, [
    start,
    c.env.DB.prepare(`UPDATE groups SET ${updates.join(',')},version=version+1 WHERE id=?`).bind(...values, groupId),
    end,
  ]);
  return c.json(groupJson({ ...current, name, default_currency_code: defaultCurrencyCode, version: version + 1 }));
});

groups.delete('/groups/:id', async c => {
  const version = expectedVersion(c);
  const groupId = id(c.req.param('id'));
  const userId = c.get('userId');
  const current = await groupForOwner(c.env.DB, groupId, userId);
  checkVersion(current.version, version);
  const [start, end] = ownerGuard(c.env.DB, groupId, userId, version);
  const before = expenseJsonSql('e');
  await commit(c.env.DB, [
    start,
    c.env.DB.prepare('UPDATE groups SET version=version+1 WHERE id=?').bind(groupId),
    c.env.DB.prepare(`
      INSERT INTO audit_events(entity_type,entity_id,actor_user_id,action,created_at,before_json,after_json)
      SELECT 'expense',e.id,?,'detach',?,${before},json_set(${before},'$.groupId',NULL,'$.version',e.version+1)
      FROM expenses e WHERE e.group_id=?
    `).bind(userId, Date.now(), groupId),
    c.env.DB.prepare('UPDATE expenses SET version=version+1 WHERE group_id=?').bind(groupId),
    c.env.DB.prepare('DELETE FROM groups WHERE id=?').bind(groupId),
    end,
  ]);
  return c.body(null, 204);
});

groups.get('/groups/:id/members', async c => {
  const groupId = id(c.req.param('id'));
  const userId = c.get('userId');
  await requireMember(c.env.DB, groupId, userId);
  const p = page(c, `group-members:${groupId}`);
  numericCursor(p);
  const cursor = p.sort === null ? '' : 'AND (gm.joined_at<? OR (gm.joined_at=? AND gm.user_id<?))';
  const bindings = p.sort === null
    ? [groupId, groupId, userId, p.limit + 1]
    : [groupId, groupId, userId, p.sort, p.sort, p.id, p.limit + 1];
  const rows = await c.env.DB.prepare(`
    SELECT gm.user_id,gm.role,gm.joined_at
    FROM group_members gm
    WHERE gm.group_id=? AND gm.left_at IS NULL AND ${memberSql} ${cursor}
    ORDER BY gm.joined_at DESC,gm.user_id DESC LIMIT ?
  `).bind(...bindings).all<MemberRow>();
  const items = rows.results.map(membershipJson);
  return c.json(paginated<Membership>(items, p, item => [Date.parse(item.joinedAt), item.userId]));
});

groups.post('/groups/:id/members', async c => {
  const version = expectedVersion(c);
  const input = await body(c);
  fields(input, ['userId']);
  const targetUserId = id(input.userId);
  const groupId = id(c.req.param('id'));
  const userId = c.get('userId');
  const current = await groupForOwner(c.env.DB, groupId, userId);
  await requireUsers(c.env.DB, [targetUserId]);
  const existing = await c.env.DB.prepare('SELECT user_id,role,joined_at,left_at FROM group_members WHERE group_id=? AND user_id=?')
    .bind(groupId, targetUserId).first<MemberRow>();
  if (existing && existing.left_at === null) fail(409, 'already_member', 'That user is already a group member.');
  checkVersion(current.version, version);

  const now = Date.now();
  const [start, end] = guard(
    c.env.DB,
    `EXISTS(
      SELECT 1 FROM groups g JOIN group_members gm ON gm.group_id=g.id
      WHERE g.id=? AND g.created_by_user_id=? AND gm.user_id=? AND gm.role='owner' AND gm.left_at IS NULL
    ) AND NOT EXISTS(
      SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND left_at IS NULL
    )`,
    [groupId, userId, userId, groupId, targetUserId],
    'SELECT version=? FROM groups WHERE id=?',
    [version, groupId],
  );
  await commit(c.env.DB, [
    start,
    c.env.DB.prepare(`
      INSERT INTO group_members(group_id,user_id,role,joined_at) VALUES(?,?,'member',?)
      ON CONFLICT(group_id,user_id) DO UPDATE SET role='member',left_at=NULL
    `).bind(groupId, targetUserId, now),
    c.env.DB.prepare('UPDATE groups SET version=version+1 WHERE id=?').bind(groupId),
    end,
  ]);
  return c.json(membershipJson({ user_id: targetUserId, role: 'member', joined_at: existing?.joined_at ?? now }));
});

groups.delete('/groups/:id/members/:userId', async c => {
  const version = expectedVersion(c);
  const groupId = id(c.req.param('id'));
  const targetUserId = id(c.req.param('userId'));
  const userId = c.get('userId');
  const current = await groupForMember(c.env.DB, groupId, userId);
  checkVersion(current.version, version);
  const target = await c.env.DB.prepare('SELECT user_id,role,joined_at FROM group_members WHERE group_id=? AND user_id=? AND left_at IS NULL')
    .bind(groupId, targetUserId).first<MemberRow>();
  if (!target) fail(404, 'not_found', 'Active group membership not found.');
  if (target.role === 'owner') fail(409, 'owner_cannot_leave', 'The group owner cannot leave or be removed.');
  if (targetUserId !== userId && (current.created_by_user_id !== userId || current.member_role !== 'owner')) {
    fail(403, 'owner_required', 'Only the group owner can remove another member.');
  }

  const ownerCheck = targetUserId === userId
    ? "EXISTS(SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND left_at IS NULL AND role<>'owner')"
    : `EXISTS(
        SELECT 1 FROM groups g JOIN group_members actor ON actor.group_id=g.id
        JOIN group_members target ON target.group_id=g.id
        WHERE g.id=? AND g.created_by_user_id=? AND actor.user_id=? AND actor.role='owner' AND actor.left_at IS NULL
          AND target.user_id=? AND target.role<>'owner' AND target.left_at IS NULL
      )`;
  const ownerValues = targetUserId === userId
    ? [groupId, userId]
    : [groupId, userId, userId, targetUserId];
  const [start, end] = guard(
    c.env.DB,
    ownerCheck,
    ownerValues,
    'SELECT version=? FROM groups WHERE id=?',
    [version, groupId],
  );
  await commit(c.env.DB, [
    start,
    c.env.DB.prepare('UPDATE group_members SET left_at=? WHERE group_id=? AND user_id=?').bind(Date.now(), groupId, targetUserId),
    c.env.DB.prepare('UPDATE groups SET version=version+1 WHERE id=?').bind(groupId),
    end,
  ]);
  return c.json(membershipJson(target));
});

groups.get('/groups/:id/expenses', async c => {
  const groupId = id(c.req.param('id'));
  const userId = c.get('userId');
  await requireMember(c.env.DB, groupId, userId);
  const p = page(c, `group-expenses:${groupId}`);
  numericCursor(p);
  const cursor = p.sort === null ? '' : 'AND (e.incurred_at<? OR (e.incurred_at=? AND e.id<?))';
  const bindings = p.sort === null
    ? [groupId, groupId, userId, p.limit + 1]
    : [groupId, groupId, userId, p.sort, p.sort, p.id, p.limit + 1];
  const rows = await c.env.DB.prepare(`
    SELECT ${expenseJsonSql('e')} AS resource,e.incurred_at,e.id
    FROM expenses e
    WHERE e.group_id=? AND ${memberSql} ${cursor}
    ORDER BY e.incurred_at DESC,e.id DESC LIMIT ?
  `).bind(...bindings).all<{ resource: string; incurred_at: number; id: string }>();
  const resources = rows.results.map(row => ({ value: JSON.parse(row.resource) as unknown, sort: row.incurred_at, id: row.id }));
  const result = paginated(resources, p, item => [item.sort, item.id]);
  return c.json({ items: result.items.map(item => item.value), nextCursor: result.nextCursor });
});
