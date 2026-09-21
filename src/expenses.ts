import { Hono } from 'hono';
import { amount, body, commit, currency, date, expectedVersion, fail, fields, guard, id, memberSql, object, page, paginated, requireMember, requireUsers, text, type ApiContext, type Bindings } from './api';
import { allocateExpense, type Amount, type Split } from './money';
import { audit, balanceGuard, createRecord, expenseJsonSql, history, ownExpense, readExpense, receipt, type ExpenseRecord } from './records';

export const expenses = new Hono<Bindings>();
type ExpenseInput = Omit<ExpenseRecord, 'id' | 'createdByUserId' | 'createdAt' | 'version'>;
function amounts(value: unknown): Amount[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) fail(400, 'invalid_input', 'Supply between 1 and 50 payments or shares.');
  return value.map((item: unknown) => { const entry = object(item); fields(entry, ['userId', 'amountMinor']); return { userId: id(entry.userId), amountMinor: amount(entry.amountMinor) }; });
}
async function input(c: ApiContext): Promise<ExpenseInput> {
  const raw = await body(c);
  fields(raw, ['description', 'currencyCode', 'amountMinor', 'incurredAt', 'groupId', 'payments', 'split']);
  const total = amount(raw.amountMinor);
  const payments = amounts(raw.payments).sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  const splitting = object(raw.split);
  let split: Split;
  if (splitting.type === 'equal') {
    fields(splitting, ['type', 'userIds']);
    if (!Array.isArray(splitting.userIds) || splitting.userIds.length > 50) fail(400, 'invalid_split', 'Supply up to 50 participant IDs.');
    split = { type: 'equal', userIds: splitting.userIds.map((value: unknown) => id(value)) };
  } else if (splitting.type === 'exact') {
    fields(splitting, ['type', 'shares']);
    split = { type: 'exact', shares: amounts(splitting.shares) };
  } else fail(400, 'invalid_split', 'Use an equal or exact split.');
  let calculated: ReturnType<typeof allocateExpense>;
  try { calculated = allocateExpense(total, payments, split); } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) fail(400, 'invalid_split', error.message);
    throw error;
  }
  return { description: text(raw.description, 'description', 200), currencyCode: currency(raw.currencyCode), amountMinor: total,
    incurredAt: date(raw.incurredAt, 'incurredAt'), groupId: raw.groupId == null ? null : id(raw.groupId), payments, ...calculated };
}
function participantIds(record: ExpenseInput): string[] { return [...new Set([...record.payments, ...record.shares].map(value => value.userId))]; }
function children(db: D1Database, record: ExpenseRecord): D1PreparedStatement[] {
  return [
    db.prepare("INSERT INTO expense_payments(expense_id,user_id,amount_minor) SELECT ?,json_extract(value,'$.userId'),json_extract(value,'$.amountMinor') FROM json_each(?)").bind(record.id, JSON.stringify(record.payments)),
    db.prepare("INSERT INTO expense_shares(expense_id,user_id,amount_minor) SELECT ?,json_extract(value,'$.userId'),json_extract(value,'$.amountMinor') FROM json_each(?)").bind(record.id, JSON.stringify(record.shares)),
    db.prepare("INSERT INTO expense_allocations(expense_id,debtor_user_id,creditor_user_id,amount_minor) SELECT ?,json_extract(value,'$.debtorUserId'),json_extract(value,'$.creditorUserId'),json_extract(value,'$.amountMinor') FROM json_each(?)").bind(record.id, JSON.stringify(record.allocations)),
  ];
}
function clearChildren(db: D1Database, expenseId: string): D1PreparedStatement[] {
  return ['expense_allocations', 'expense_payments', 'expense_shares'].map(table => db.prepare(`DELETE FROM ${table} WHERE expense_id=?`).bind(expenseId));
}
expenses.post('/expenses', async c => {
  const values = await input(c);
  const creation = await receipt(c, 'expense', values);
  if (creation.existing) { c.header('ETag', `"${creation.existing.version}"`); return c.json(creation.existing, 201); }
  const actor = c.get('userId');
  const ids = participantIds(values);
  if (!ids.includes(actor)) fail(403, 'participation_required', 'The creator must pay or owe a share.');
  await requireUsers(c.env.DB, ids);
  if (values.groupId) await requireMember(c.env.DB, values.groupId, actor);
  const now = Date.now();
  const record: ExpenseRecord = { ...values, id: crypto.randomUUID(), createdByUserId: actor, createdAt: new Date(now).toISOString(), version: 1 };
  const statements = values.groupId ? guard(c.env.DB, memberSql, [values.groupId, actor], '1', []) : [];
  statements.push(c.env.DB.prepare('INSERT INTO expenses(id,group_id,created_by_user_id,description,currency_code,amount_minor,incurred_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(record.id, record.groupId, actor, record.description, record.currencyCode, record.amountMinor, Date.parse(record.incurredAt), now), ...children(c.env.DB, record));
  const saved = await createRecord(c, 'expense', creation, statements, record);
  c.header('ETag', `"${saved.version}"`);
  return c.json(saved, 201);
});
expenses.get('/expenses/:id/history', c => history(c, 'expense', c.req.param('id')));
expenses.get('/expenses/:id', async c => { const record = await readExpense(c, c.req.param('id')); c.header('ETag', `"${record.version}"`); return c.json(record); });
expenses.put('/expenses/:id', async c => {
  const before = await readExpense(c, c.req.param('id'));
  const expected = expectedVersion(c);
  ownExpense(before, c.get('userId'), expected);
  const values = await input(c);
  if (values.currencyCode !== before.currencyCode) fail(400, 'immutable_currency', 'Delete and recreate an expense to correct its currency.');
  const ids = participantIds(values);
  if (!ids.includes(c.get('userId'))) fail(403, 'participation_required', 'The creator must remain a payer or participant.');
  await requireUsers(c.env.DB, ids);
  const movedIntoGroup = values.groupId !== null && values.groupId !== before.groupId;
  if (movedIntoGroup) await requireMember(c.env.DB, values.groupId as string, c.get('userId'));
  const after: ExpenseRecord = { ...before, ...values, version: expected + 1 };
  const allowed = movedIntoGroup ? memberSql : '1';
  const statements = guard(c.env.DB, allowed, movedIntoGroup ? [values.groupId, c.get('userId')] : [], 'SELECT version=? AND created_by_user_id=? FROM expenses WHERE id=?', [expected, c.get('userId'), before.id]);
  statements.push(...clearChildren(c.env.DB, before.id), c.env.DB.prepare('UPDATE expenses SET group_id=?,description=?,amount_minor=?,incurred_at=?,version=version+1 WHERE id=?')
    .bind(after.groupId, after.description, after.amountMinor, Date.parse(after.incurredAt), after.id), ...children(c.env.DB, after), audit(c, 'expense', 'update', before, after, null), ...balanceGuard(c.env.DB, [before, after]));
  await commit(c.env.DB, statements);
  c.header('ETag', `"${after.version}"`);
  return c.json(after);
});
expenses.delete('/expenses/:id', async c => {
  const before = await readExpense(c, c.req.param('id'));
  const expected = expectedVersion(c); ownExpense(before, c.get('userId'), expected);
  await commit(c.env.DB, [...guard(c.env.DB, '1', [], 'SELECT version=? AND created_by_user_id=? FROM expenses WHERE id=?', [expected, c.get('userId'), before.id]),
    ...clearChildren(c.env.DB, before.id), c.env.DB.prepare('DELETE FROM expenses WHERE id=?').bind(before.id), audit(c, 'expense', 'delete', before, null, null), ...balanceGuard(c.env.DB, [before])]);
  return c.body(null, 204);
});
expenses.get('/expenses', async c => {
  const actor = c.get('userId');
  const p = page(c, `expenses:${actor}`);
  const rows = await c.env.DB.prepare(`SELECT ${expenseJsonSql('e')} AS snapshot FROM expenses e
    WHERE (e.created_by_user_id=?1 OR EXISTS(SELECT 1 FROM expense_involvement WHERE expense_id=e.id AND user_id=?1))
      AND (?2 IS NULL OR (e.incurred_at,e.id)<(?2,?3)) ORDER BY e.incurred_at DESC,e.id DESC LIMIT ?4`)
    .bind(actor, p.sort, p.id, p.limit + 1).all<{snapshot: string}>();
  return c.json(paginated(rows.results.map(row => JSON.parse(row.snapshot) as ExpenseRecord), p, item => [Date.parse(item.incurredAt), item.id]));
});
