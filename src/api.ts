import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './auth';

export type Bindings = { Bindings: AppEnv; Variables: { userId: string; requestId: string } };
export type ApiContext = Context<Bindings>;
export class ApiError extends Error {
  constructor(public status: ContentfulStatusCode, public code: string, message: string) { super(message); }
}
export function fail(status: ContentfulStatusCode, code: string, message: string): never { throw new ApiError(status, code, message); }
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(400, 'invalid_input', 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function fields(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'invalid_input', 'Request contains an unsupported field.');
}
export async function body(c: ApiContext): Promise<Record<string, unknown>> {
  if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'json_required', 'Use Content-Type: application/json.');
  try { return object(await c.req.json<unknown>()); } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, 'invalid_json', 'Send a valid JSON object.');
  }
}
export function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, 'invalid_input', `${name} must contain 1–${max} characters.`);
  return value.trim();
}
export function id(value: unknown): string { return text(value, 'user/group ID', 128); }
export function currency(value: unknown): 'CAD' | 'USD' {
  if (value !== 'CAD' && value !== 'USD') fail(400, 'invalid_currency', 'Use CAD or USD.');
  return value;
}
export function amount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(400, 'invalid_amount', 'amountMinor must be a positive safe integer number of cents.');
  return value;
}
export function date(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)) fail(400, 'invalid_date', `${name} requires an ISO timestamp with a timezone.`);
  const millis = Date.parse(value);
  const day = Number(value.slice(8, 10));
  const month = Number(value.slice(5, 7));
  const year = Number(value.slice(0, 4));
  if (!Number.isFinite(millis) || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || millis < 0 || millis > Date.now()) fail(400, 'invalid_date', `${name} must be a valid date between 1970 and now.`);
  return new Date(millis).toISOString();
}
export function expectedVersion(c: ApiContext): number {
  const value = c.req.header('If-Match');
  if (!value) fail(428, 'version_required', 'Send the resource version as a quoted If-Match header.');
  if (!/^"[1-9]\d*"$/.test(value) || !Number.isSafeInteger(Number(value.slice(1, -1)))) fail(400, 'invalid_version', 'If-Match must be a quoted positive integer.');
  return Number(value.slice(1, -1));
}
export function checkVersion(actual: number, expected: number): void {
  if (actual !== expected) fail(412, 'stale_version', 'The record changed. Reload it and submit the correction again.');
}
export function guard(db: D1Database, allowedSql: string, allowedValues: unknown[], versionSql: string, versionValues: unknown[]): D1PreparedStatement[] {
  const token = crypto.randomUUID();
  return [db.prepare(`INSERT INTO mutation_guards(id,allowed,current) VALUES(?,COALESCE((${allowedSql}),0),COALESCE((${versionSql}),0))`).bind(token, ...allowedValues, ...versionValues), db.prepare('DELETE FROM mutation_guards WHERE id=?').bind(token)];
}
export async function commit(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try { return await db.batch(statements); } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('mutation_current')) fail(412, 'stale_version', 'The record changed. Reload before retrying.');
    if (message.includes('mutation_allowed')) fail(409, 'access_changed', 'Membership or permissions changed. Reload before retrying.');
    if (message.includes('money_overflow')) fail(400, 'balance_overflow', 'This change would exceed the supported balance range.');
    if (message.includes('FOREIGN KEY constraint')) fail(400, 'unknown_reference', 'A referenced user or group no longer exists.');
    throw error;
  }
}
export const memberSql = 'EXISTS(SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND left_at IS NULL)';
export async function requireMember(db: D1Database, groupId: string, userId: string): Promise<void> {
  const row = await db.prepare('SELECT 1 AS ok WHERE ' + memberSql).bind(groupId, userId).first();
  if (!row) fail(404, 'not_found', 'Group not found.');
}
export async function requireUsers(db: D1Database, ids: string[]): Promise<void> {
  const rows = await db.prepare("SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM user_identities WHERE user_id=users.id AND provider='google')").bind(JSON.stringify(ids)).all<{id: string}>();
  if (rows.results.length !== new Set(ids).size) fail(400, 'unknown_user', 'Every participant must be a registered user.');
}
export interface Page { limit: number; scope: string; sort: number | string | null; id: string | null }
export function page(c: ApiContext, scope: string): Page {
  const rawLimit = c.req.query('limit') ?? '25';
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) fail(400, 'invalid_page', 'limit must be between 1 and 100.');
  const result: Page = { limit: Number(rawLimit), scope, sort: null, id: null };
  const cursor = c.req.query('cursor');
  if (!cursor) return result;
  try {
    if (cursor.length > 2048) throw new Error();
    const decoded = object(JSON.parse(atob(cursor)));
    if (decoded.scope !== scope || !['string', 'number'].includes(typeof decoded.sort) || typeof decoded.id !== 'string') throw new Error();
    result.sort = decoded.sort as string | number; result.id = decoded.id;
  } catch { fail(400, 'invalid_cursor', 'Use a cursor returned by this list endpoint.'); }
  return result;
}
export function paginated<T>(items: T[], p: Page, key: (item: T) => [number | string, string]): {items: T[]; nextCursor: string | null} {
  const visible = items.slice(0, p.limit);
  const last = visible.at(-1);
  const [sort, lastId] = last === undefined ? [null, null] : key(last);
  return { items: visible, nextCursor: items.length > p.limit ? btoa(JSON.stringify({ scope: p.scope, sort, id: lastId })) : null };
}
