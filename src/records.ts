import { checkVersion, commit, fail, page, paginated, type ApiContext } from './api';
import type { Allocation, Amount } from './money';

export interface ExpenseRecord {
  id: string; createdByUserId: string; description: string; currencyCode: 'CAD' | 'USD'; amountMinor: number;
  incurredAt: string; createdAt: string; groupId: string | null; version: number;
  payments: Amount[]; shares: Amount[]; allocations: Allocation[];
}
export interface SettlementRecord {
  id: string; recordedByUserId: string; paidByUserId: string; paidToUserId: string; currencyCode: 'CAD' | 'USD'; amountMinor: number;
  settledAt: string; createdAt: string; note: string | null; version: number;
}
export type Snapshot = ExpenseRecord | SettlementRecord;
export type Entity = 'expense' | 'settlement';

export function expenseJsonSql(alias: string): string {
  return `json_object('id',${alias}.id,'createdByUserId',${alias}.created_by_user_id,'description',${alias}.description,
    'currencyCode',${alias}.currency_code,'amountMinor',${alias}.amount_minor,'groupId',${alias}.group_id,'version',${alias}.version,
    'incurredAt',strftime('%Y-%m-%dT%H:%M:%fZ',${alias}.incurred_at/1000.0,'unixepoch'),
    'createdAt',strftime('%Y-%m-%dT%H:%M:%fZ',${alias}.created_at/1000.0,'unixepoch'),
    'payments',json((SELECT json_group_array(json_object('userId',p.user_id,'amountMinor',p.amount_minor)) FROM (SELECT * FROM expense_payments WHERE expense_id=${alias}.id ORDER BY user_id) p)),
    'shares',json((SELECT json_group_array(json_object('userId',s.user_id,'amountMinor',s.amount_minor)) FROM (SELECT * FROM expense_shares WHERE expense_id=${alias}.id ORDER BY user_id) s)),
    'allocations',json((SELECT json_group_array(json_object('debtorUserId',a.debtor_user_id,'creditorUserId',a.creditor_user_id,'amountMinor',a.amount_minor)) FROM (SELECT * FROM expense_allocations WHERE expense_id=${alias}.id ORDER BY debtor_user_id,creditor_user_id) a)))`;
}
export function settlementJsonSql(alias: string): string {
  return `json_object('id',${alias}.id,'recordedByUserId',${alias}.recorded_by_user_id,'paidByUserId',${alias}.paid_by_user_id,'paidToUserId',${alias}.paid_to_user_id,
    'currencyCode',${alias}.currency_code,'amountMinor',${alias}.amount_minor,'note',${alias}.note,'version',${alias}.version,
    'settledAt',strftime('%Y-%m-%dT%H:%M:%fZ',${alias}.settled_at/1000.0,'unixepoch'),
    'createdAt',strftime('%Y-%m-%dT%H:%M:%fZ',${alias}.created_at/1000.0,'unixepoch'))`;
}
export const expenseAccessSql = `(e.created_by_user_id=?2 OR EXISTS(SELECT 1 FROM expense_involvement WHERE expense_id=e.id AND user_id=?2)
 OR EXISTS(SELECT 1 FROM group_members WHERE group_id=e.group_id AND user_id=?2 AND left_at IS NULL))`;
export async function readExpense(c: ApiContext, expenseId: string): Promise<ExpenseRecord> {
  const row = await c.env.DB.prepare(`SELECT ${expenseJsonSql('e')} AS snapshot FROM expenses e WHERE e.id=?1 AND ${expenseAccessSql}`).bind(expenseId, c.get('userId')).first<{snapshot: string}>();
  if (!row) fail(404, 'not_found', 'Expense not found.');
  return JSON.parse(row.snapshot) as ExpenseRecord;
}
export async function readSettlement(c: ApiContext, settlementId: string): Promise<SettlementRecord> {
  const row = await c.env.DB.prepare(`SELECT ${settlementJsonSql('s')} AS snapshot FROM settlements s WHERE s.id=?1 AND (s.paid_by_user_id=?2 OR s.paid_to_user_id=?2)`).bind(settlementId, c.get('userId')).first<{snapshot: string}>();
  if (!row) fail(404, 'not_found', 'Settlement not found.');
  return JSON.parse(row.snapshot) as SettlementRecord;
}
export function ownExpense(record: ExpenseRecord, userId: string, version: number): void {
  if (record.createdByUserId !== userId) fail(403, 'creator_only', 'Only the expense creator can change it.');
  checkVersion(record.version, version);
}
export function ownSettlement(record: SettlementRecord, userId: string, version: number): void {
  if (record.recordedByUserId !== userId) fail(403, 'recorder_only', 'Only the settlement recorder can change it.');
  checkVersion(record.version, version);
}
interface Receipt { key: string; hash: string; existing: Snapshot | null }
export async function receipt(c: ApiContext, entity: Entity, input: object): Promise<Receipt> {
  const key = c.req.header('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) fail(400, 'idempotency_required', 'Send an Idempotency-Key of 1–128 ASCII letters, digits, dots, underscores, colons or hyphens.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  const hash = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  return { key, hash, existing: await replay(c, entity, key, hash) };
}
async function replay(c: ApiContext, entity: Entity, key: string, hash: string): Promise<Snapshot | null> {
  const row = await c.env.DB.prepare('SELECT request_hash,after_json FROM audit_events WHERE actor_user_id=? AND entity_type=? AND idempotency_key=?').bind(c.get('userId'), entity, key).first<{request_hash: string; after_json: string}>();
  if (!row) return null;
  if (row.request_hash !== hash) fail(409, 'idempotency_conflict', 'This key was used for different input. Use a new key for a new record.');
  return JSON.parse(row.after_json) as Snapshot;
}
export function audit(c: ApiContext, entity: Entity, action: 'create' | 'update' | 'delete', before: Snapshot | null, after: Snapshot | null, creation: Receipt | null): D1PreparedStatement {
  return c.env.DB.prepare('INSERT INTO audit_events(entity_type,entity_id,actor_user_id,action,created_at,before_json,after_json,idempotency_key,request_hash) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(entity, (after ?? before)?.id, c.get('userId'), action, Date.now(), before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), creation?.key ?? null, creation?.hash ?? null);
}
export function balanceGuard(db: D1Database, snapshots: Snapshot[]): D1PreparedStatement[] {
  const pairs = new Map<string, { currency: string; low: string; high: string }>();
  for (const snapshot of snapshots) {
    const edges = 'allocations' in snapshot ? snapshot.allocations.map(edge => [edge.debtorUserId, edge.creditorUserId]) : [[snapshot.paidByUserId, snapshot.paidToUserId]];
    for (const edge of edges) {
      const [low, high] = [...edge].sort();
      const pair = { currency: snapshot.currencyCode, low, high };
      pairs.set(JSON.stringify(pair), pair);
    }
  }
  const token = crypto.randomUUID();
  // Existing triggers reverse old entries first; only the final transaction balance must fit JSON integers.
  return [db.prepare(`INSERT INTO mutation_guards(id,allowed,current,money_safe) VALUES(?,1,1,NOT EXISTS(
    SELECT 1 FROM json_each(?) p JOIN pair_balances b
      ON b.currency_code=json_extract(p.value,'$.currency') AND b.user_low_id=json_extract(p.value,'$.low') AND b.user_high_id=json_extract(p.value,'$.high')
    WHERE typeof(b.net_minor)<>'integer' OR b.net_minor>9007199254740991 OR b.net_minor< -9007199254740991))`).bind(token, JSON.stringify([...pairs.values()])),
    db.prepare('DELETE FROM mutation_guards WHERE id=?').bind(token)];
}
export async function createRecord(c: ApiContext, entity: Entity, creation: Receipt, statements: D1PreparedStatement[], after: Snapshot): Promise<Snapshot> {
  try { await commit(c.env.DB, [...statements, audit(c, entity, 'create', null, after, creation), ...balanceGuard(c.env.DB, [after])]); } catch (error) {
    const existing = await replay(c, entity, creation.key, creation.hash);
    if (existing) return existing;
    throw error;
  }
  return after;
}
function snapshotAccessSql(snapshot: string, entity: Entity): string {
  if (entity === 'settlement') return `(json_extract(${snapshot},'$.paidByUserId')=?1 OR json_extract(${snapshot},'$.paidToUserId')=?1)`;
  return `(json_extract(${snapshot},'$.createdByUserId')=?1
    OR EXISTS(SELECT 1 FROM json_each(${snapshot},'$.payments') WHERE json_extract(value,'$.userId')=?1)
    OR EXISTS(SELECT 1 FROM json_each(${snapshot},'$.shares') WHERE json_extract(value,'$.userId')=?1)
    OR EXISTS(SELECT 1 FROM group_members WHERE group_id=json_extract(${snapshot},'$.groupId') AND user_id=?1 AND left_at IS NULL))`;
}
export async function history(c: ApiContext, entity: Entity, entityId: string): Promise<Response> {
  const p = page(c, `${entity}:${entityId}:history:${c.get('userId')}`);
  const beforeAccess = snapshotAccessSql('before_json', entity);
  const afterAccess = snapshotAccessSql('after_json', entity);
  const filter = `entity_type=?2 AND entity_id=?3 AND (${beforeAccess} OR ${afterAccess})`;
  const rows = await c.env.DB.prepare(`SELECT id,action,actor_user_id AS actorUserId,created_at AS createdAt,
    CASE WHEN ${beforeAccess} THEN before_json END AS before, CASE WHEN ${afterAccess} THEN after_json END AS after
    FROM audit_events WHERE ${filter} AND (?4 IS NULL OR id<?4) ORDER BY id DESC LIMIT ?5`)
    .bind(c.get('userId'), entity, entityId, p.sort, p.limit + 1).all<{id: number; action: string; actorUserId: string; createdAt: number; before: string | null; after: string | null}>();
  if (!rows.results.length) {
    const visible = await c.env.DB.prepare(`SELECT 1 AS ok FROM audit_events WHERE ${filter} LIMIT 1`).bind(c.get('userId'), entity, entityId).first();
    if (!visible) fail(404, 'not_found', 'History not found.');
  }
  const items = rows.results.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString(), before: row.before === null ? null : JSON.parse(row.before) as Snapshot, after: row.after === null ? null : JSON.parse(row.after) as Snapshot }));
  return c.json(paginated(items, p, item => [item.id, String(item.id)]));
}
