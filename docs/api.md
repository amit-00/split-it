# Expense sharing API

The Worker serves JSON endpoints under `/api`. Sign in with Google through the existing `/api/auth/sign-in/social` flow and keep its cookies. `/api/me` returns the durable application user ID; use that ID for all financial references. Older sessions without that identity must sign in again. Only signed-in Google users can be participants.

## Requests, versions and retries

Send `Content-Type: application/json` for JSON bodies and the configured application `Origin` on all financial/group writes. Cookies authenticate the caller; caller IDs, creator IDs, recorder IDs and versions are assigned by the server. Bodies with unsupported fields are rejected. Authentication endpoints keep Better Auth's own request and error contracts.

Expense and settlement creation require an `Idempotency-Key` header (1–128 ASCII letters/digits or `._:-`). Generate a fresh key for a new operation; reuse it if a request times out. A key is scoped to the authenticated user and resource type. Semantically identical normalized input returns the original `201` resource; changed input returns `409`. Creation receipts are retained after edits and deletion, so replay returns the original version and never resurrects a deleted record. Reload the resource to get its current state.

Edits, deletes and group membership changes require `If-Match: "1"`, using the resource version most recently read. Expense/settlement GET/create/update responses also include that ETag. For membership changes use the **group** version, then fetch the group for its next version. Missing versions return `428`; stale versions return `412`. Concurrent membership changes can also return `409` when the membership itself changed. Group creation is not retry-deduplicated.

Lists return `{ "items": [...], "nextCursor": null }`. Use `?limit=25` (1–100) and pass the returned opaque `cursor` to fetch the next page. Cursors belong to their endpoint and scope. Expense/settlement feeds sort by financial timestamp descending, with ID as a tie-breaker. Pagination is a live view: concurrent edits can move records between pages.

App errors use:

```json
{
  "error": { "code": "stale_version", "message": "The record changed. Reload before retrying." },
  "requestId": "request-uuid"
}
```

Responses are private (`Cache-Control: no-store`) and carry `X-Request-ID`. `400` means invalid input, `401` requires sign-in, `403` denies an action, `404` hides absent/inaccessible records, `409` indicates a state/key conflict, `412` means stale version, `413` means excessive body size, `415` requires JSON, `428` requires a version, and `429` limits lookup. Unexpected failures return a redacted `500`; recognized temporary database failures return `503`. Retry financial creation with the same key after a timeout/temporary error.

## People and groups

| Method/path | Body or result |
|---|---|
| `GET /api/me` | `{user:{id,name,email,avatarUrl}}` |
| `GET /api/users?email=...` | Required exact email query; result `{id,name,avatarUrl}` |
| `GET /api/groups` | Current membership groups |
| `POST /api/groups` | `{name,defaultCurrencyCode?}`; returns a group, `201` |
| `GET /api/groups/:id` | A group visible to current members |
| `PATCH /api/groups/:id` | Owner supplies `name` and/or `defaultCurrencyCode` |
| `DELETE /api/groups/:id` | Owner deletes group; `204` |
| `GET /api/groups/:id/members` | Current members `{userId,role,joinedAt}` |
| `POST /api/groups/:id/members` | Owner supplies `{userId}`; returns membership |
| `DELETE /api/groups/:id/members/:userId` | Owner removes member, or member leaves; returns removed membership |
| `GET /api/groups/:id/expenses` | Shared expense list for current members |

Group resources are `{id,name,defaultCurrencyCode,createdByUserId,createdAt,version}`. Currency defaults are `CAD`, `USD` or `null`; they do not convert money or fill in omitted expense currencies. Names contain 1–200 characters. Creator is owner, and cannot leave or be removed. Ownership transfer is not supported. Rejoining reactivates the historical membership and retains its original `joinedAt`.

Lookup requires exactly one `email` query parameter, such as `/api/users?email=alice%2Btrip%40example.com`; URL-encode the value so `+` remains literal. Missing, duplicate, or unsupported query parameters are rejected. Lookup trims whitespace and ignores ASCII case; it does not strip dots or `+` suffixes. It requires the complete email, never lists users, and reports ambiguous registered matches as `409`. It allows 30 lookups per minute per caller. Email remains mutable profile data, not an account identity.

Adding a member grants access to existing grouped expenses. Removing someone revokes group-derived access while preserving access to expenses they created or financially participate in. Deleting a group detaches its expenses, increments their versions, and records detach audit events. Balances and settlements are unchanged.

## Expenses

| Method/path | Behavior |
|---|---|
| `GET /api/expenses` | Expenses the caller created, paid toward, or shares |
| `POST /api/expenses` | Create; `201` with full resource |
| `GET /api/expenses/:id` | Read full resource |
| `PUT /api/expenses/:id` | Creator replaces editable content; returns new resource |
| `DELETE /api/expenses/:id` | Creator removes financial effect; `204` |
| `GET /api/expenses/:id/history` | Authorized revision history, including after deletion |

Create or replace an expense with:

```json
{
  "description": "Dinner",
  "currencyCode": "CAD",
  "amountMinor": 3000,
  "incurredAt": "2026-01-01T18:00:00-05:00",
  "groupId": null,
  "payments": [{"userId": "alice-id", "amountMinor": 3000}],
  "split": {"type": "equal", "userIds": ["alice-id", "bob-id", "carol-id"]}
}
```

For exact splitting replace `split` with:

```json
{"type":"exact","shares":[{"userId":"alice-id","amountMinor":500},{"userId":"bob-id","amountMinor":2500}]}
```

Full responses include `id`, `createdByUserId`, `createdAt`, `version`, the editable fields except `split`, resolved `payments`/`shares`, and `allocations:[{debtorUserId,creditorUserId,amountMinor}]`. Dates are returned in UTC. `groupId` defaults to `null`; PUT is a full replacement, so omitting it detaches the expense.

All money uses positive integer cents. Payments and shares each sum exactly to the total. Multiple payers are allowed; duplicates within a list are rejected. Equal splits assign leftover cents in stable ascending user-ID order and require at least one cent per participant. At most 50 distinct users can pay/share. No floating-point values or negative/refund entries are accepted.

The creator must be a payer or share participant, including after editing. Grouped expense creation requires current group membership; other payers/participants may be outside the group. Creators can correct their existing expenses after leaving, but cannot attach them to groups they no longer belong to. Only the creator can edit/delete; current group members and financial participants can view.

Currency cannot be edited: delete and recreate to correct it. Editing/deleting after settlement is allowed; payments remain recorded and balances adjust. Description is 1–200 characters. Dates require full timestamps with a timezone, from the Unix epoch through the current time; invalid calendar dates and future dates are rejected.

## Settlements and balances

| Method/path | Behavior |
|---|---|
| `GET /api/settlements` | Payments where caller is payer or recipient |
| `POST /api/settlements` | Either party records a completed external payment; `201` |
| `GET /api/settlements/:id` | Both parties may read |
| `PUT /api/settlements/:id` | Recorder corrects amount, date and note |
| `DELETE /api/settlements/:id` | Recorder reverses financial effect; `204` |
| `GET /api/settlements/:id/history` | Both parties may read retained history |
| `GET /api/balances` | Caller-only current pair balances |

Create/replace body:

```json
{
  "paidByUserId": "bob-id",
  "paidToUserId": "alice-id",
  "currencyCode": "CAD",
  "amountMinor": 1500,
  "settledAt": "2026-01-02T00:00:00Z",
  "note": "Bank transfer"
}
```

Responses add `id`, `recordedByUserId`, `createdAt`, and `version`. Notes are optional/null or 1–1000 characters. PUT requires the same payer, recipient and currency; correct those by deleting and recreating. Self-payments are rejected. Overpayments and payments with no prior debt are accepted immediately. No money is transferred by this API.

Balances return entries such as:

```json
{"userId":"alice-id","currencyCode":"CAD","amountMinor":500,"direction":"owedToYou"}
```

`owedByYou` means the caller owes that user; `owedToYou` means they owe the caller. Zero balances are omitted. CAD and USD remain separate. There is no group settlement or cross-person debt simplification. After Bob pays Alice 1500 cents against a 1000-cent debt, Alice owes Bob 500 cents.

## History and transaction guarantees

History entries contain `id`, `action`, `actorUserId`, `createdAt`, `before`, and `after`. Actions are `create`, `update`, `delete`, and group-driven `detach`. Financial history and retry receipts are retained indefinitely; deleting a financial record does not delete its audit history.

Snapshot permissions are checked independently: removed participants see only revisions in which they participated; group members see only revisions attached to that group. Before/after snapshots are redacted to `null` individually. Moving a standalone expense into a group does not expose its earlier standalone contents. Creators retain access to their revisions. Both settlement parties retain access to all payment revisions.

Financial writes, audit records, and existing trigger-maintained balance projections commit together. Write-time membership/version guards abort the entire batch if access or state changed. Safe integer bounds apply to both amounts and cumulative pair balances. The final balances of every affected pair are checked inside the same transaction, after trigger reversals complete; genuine overflow rolls the full operation back.

Requests are capped at 64 KiB. Lists are bounded; group deletion necessarily processes every expense attached to that group in one transaction. This first version targets personal sharing groups. Very large group deletion can exceed D1's execution limits and would require a separate staged lifecycle design.
