import { Hono } from 'hono';
import { amount, body, commit, currency, date, expectedVersion, fail, fields, guard, id, page, paginated, requireUsers, text, type ApiContext, type Bindings } from './api';
import { audit, balanceGuard, createRecord, history, ownSettlement, readSettlement, receipt, settlementJsonSql, type SettlementRecord } from './records';

export const settlements = new Hono<Bindings>();
type SettlementInput = Omit<SettlementRecord, 'id' | 'recordedByUserId' | 'createdAt' | 'version'>;
async function input(c: ApiContext): Promise<SettlementInput> {
  const raw = await body(c);
  fields(raw, ['paidByUserId', 'paidToUserId', 'currencyCode', 'amountMinor', 'settledAt', 'note']);
  const value: SettlementInput = { paidByUserId: id(raw.paidByUserId), paidToUserId: id(raw.paidToUserId), currencyCode: currency(raw.currencyCode), amountMinor: amount(raw.amountMinor), settledAt: date(raw.settledAt, 'settledAt'), note: raw.note == null ? null : text(raw.note, 'note', 1000) };
  if (value.paidByUserId === value.paidToUserId) fail(400, 'self_payment', 'Payer and recipient must be different users.');
  return value;
}
settlements.post('/settlements', async c => {
  const values = await input(c);
  const creation = await receipt(c, 'settlement', values);
  if (creation.existing) { c.header('ETag', `"${creation.existing.version}"`); return c.json(creation.existing, 201); }
  if (![values.paidByUserId, values.paidToUserId].includes(c.get('userId'))) fail(403, 'party_required', 'Only the payer or recipient can record a settlement.');
  await requireUsers(c.env.DB, [values.paidByUserId, values.paidToUserId]);
  const now = Date.now();
  const after: SettlementRecord = { ...values, id: crypto.randomUUID(), recordedByUserId: c.get('userId'), createdAt: new Date(now).toISOString(), version: 1 };
  const result = await createRecord(c, 'settlement', creation, [c.env.DB.prepare('INSERT INTO settlements(id,paid_by_user_id,paid_to_user_id,recorded_by_user_id,currency_code,amount_minor,settled_at,created_at,note,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(after.id, after.paidByUserId, after.paidToUserId, after.recordedByUserId, after.currencyCode, after.amountMinor, Date.parse(after.settledAt), now, after.note, JSON.stringify([after.recordedByUserId, creation.key]))], after);
  c.header('ETag', `"${result.version}"`); return c.json(result, 201);
});
settlements.get('/settlements/:id/history', c => history(c, 'settlement', c.req.param('id')));
settlements.get('/settlements/:id', async c => { const result = await readSettlement(c, c.req.param('id')); c.header('ETag', `"${result.version}"`); return c.json(result); });
settlements.put('/settlements/:id', async c => {
  const before = await readSettlement(c, c.req.param('id'));
  const expected = expectedVersion(c); ownSettlement(before, c.get('userId'), expected);
  const values = await input(c);
  if (values.paidByUserId !== before.paidByUserId || values.paidToUserId !== before.paidToUserId || values.currencyCode !== before.currencyCode) fail(400, 'immutable_parties', 'Delete and recreate the settlement to change its parties or currency.');
  const after: SettlementRecord = { ...before, ...values, version: expected + 1 };
  await commit(c.env.DB, [...guard(c.env.DB, '1', [], 'SELECT version=? AND recorded_by_user_id=? FROM settlements WHERE id=?', [expected, c.get('userId'), before.id]),
    c.env.DB.prepare('UPDATE settlements SET amount_minor=?,settled_at=?,note=?,version=version+1 WHERE id=?').bind(after.amountMinor, Date.parse(after.settledAt), after.note, after.id), audit(c, 'settlement', 'update', before, after, null), ...balanceGuard(c.env.DB, [before, after])]);
  c.header('ETag', `"${after.version}"`); return c.json(after);
});
settlements.delete('/settlements/:id', async c => {
  const before = await readSettlement(c, c.req.param('id'));
  const expected = expectedVersion(c); ownSettlement(before, c.get('userId'), expected);
  await commit(c.env.DB, [...guard(c.env.DB, '1', [], 'SELECT version=? AND recorded_by_user_id=? FROM settlements WHERE id=?', [expected, c.get('userId'), before.id]),
    c.env.DB.prepare('DELETE FROM settlements WHERE id=?').bind(before.id), audit(c, 'settlement', 'delete', before, null, null), ...balanceGuard(c.env.DB, [before])]);
  return c.body(null, 204);
});
settlements.get('/settlements', async c => {
  const p = page(c, `settlements:${c.get('userId')}`);
  const rows = await c.env.DB.prepare(`SELECT ${settlementJsonSql('s')} AS snapshot FROM settlements s WHERE (paid_by_user_id=?1 OR paid_to_user_id=?1) AND (?2 IS NULL OR (settled_at,id)<(?2,?3)) ORDER BY settled_at DESC,id DESC LIMIT ?4`)
    .bind(c.get('userId'), p.sort, p.id, p.limit + 1).all<{snapshot: string}>();
  return c.json(paginated(rows.results.map(row => JSON.parse(row.snapshot) as SettlementRecord), p, item => [Date.parse(item.settledAt), item.id]));
});
settlements.get('/balances', async c => {
  const p = page(c, `balances:${c.get('userId')}`);
  const rows = await c.env.DB.prepare(`WITH balances AS (
    SELECT currency_code AS currencyCode,user_high_id AS userId,net_minor AS net FROM pair_balances WHERE user_low_id=?1 AND net_minor<>0
    UNION ALL SELECT currency_code,user_low_id,-net_minor FROM pair_balances WHERE user_high_id=?1 AND net_minor<>0)
    SELECT * FROM balances WHERE (?2 IS NULL OR (currencyCode,userId)>(?2,?3)) ORDER BY currencyCode,userId LIMIT ?4`)
    .bind(c.get('userId'), p.sort, p.id, p.limit + 1).all<{currencyCode: string; userId: string; net: number}>();
  const items = rows.results.map(row => ({ userId: row.userId, currencyCode: row.currencyCode, amountMinor: Math.abs(row.net), direction: row.net > 0 ? 'owedByYou' : 'owedToYou' }));
  return c.json(paginated(items, p, item => [item.currencyCode, item.userId]));
});
