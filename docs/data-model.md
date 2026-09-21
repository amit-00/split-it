# Data model

The application uses Cloudflare D1 (SQLite). `migrations/0000_expense_model.sql` defines the baseline model; `0001_core_api.sql` adds the API write-safety and audit structures. Authentication still uses Better Auth's stateless cookies.

## Relationships

- `users` holds a durable app user ID and profile. `user_identities` maps a provider's stable subject to that ID. Google `sub` is the identity key; email is mutable profile data.
- `expenses` stands on its own. It has a creator, currency, amount, and date. `expense_payments` records who funded it; `expense_shares` records who consumed it. A user can appear in both. `expense_allocations` stores the debtor-to-creditor amounts computed from payments minus shares.
- `settlements` stands on its own. It records a payment from one user to another in a specific currency and has no group association.
- `groups` and `group_members` are optional expense organization and access-control structures. An expense may have a `group_id`, or it may remain standalone. A group's optional `default_currency_code` is a UI default; each expense carries its own currency. Moving an expense into or out of a group does not change anyone's balance. Deleting a group detaches its expenses instead of deleting them.
- `expense_involvement` is a trigger-maintained index of users who paid or shared an expense. `pair_balances` is a trigger-maintained current balance per currency and user pair. Positive `net_minor` means `user_low_id` owes `user_high_id`; negative means the reverse. A zero row may remain and is ignored in reads.

Money is stored as integer minor units, such as 1234 CAD cents. Never use floating point for money or add balances across currencies. Application-generated UUIDs or ULIDs can be used for IDs; timestamps are Unix milliseconds.

## Write rules

Create or edit an expense and its payment, share, and allocation rows in one database transaction. Require:

1. `SUM(expense_payments.amount_minor) = expenses.amount_minor`.
2. `SUM(expense_shares.amount_minor) = expenses.amount_minor`.
3. For each user, net position is payments minus shares. Match negative positions to positive positions deterministically and write the resulting debtor-to-creditor edges to `expense_allocations`. The sum of allocations must equal the sum of positive net positions.

For example, Alice pays 3000 cents for a three-person equal split. Shares are 1000 cents each; allocations are Bob → Alice 1000 and Carol → Alice 1000. No group is needed. Attaching the expense to a group later changes only its organization.

The database enforces row constraints, foreign keys, and updates to the balance and involvement projections. Cross-row sums require application validation in the same transaction. Expense currency is immutable after creation so allocations cannot silently move between currency balances; correct a wrong currency by replacing the expense and its allocations in a transaction. Financial edit features should record an audit trail. Use `idempotency_key` on settlements to prevent a retried payment from being recorded twice.

A settlement from A to B reduces A's total debt to B in that currency, regardless of which expenses produced it. If the payment exceeds the debt, the signed balance crosses zero and B then owes A. The API allows overpayments. Group membership and permission checks for organizing or viewing expenses belong in the API; financial participants do not need to be group members.

## Frequent reads

The indexes support keyset pagination for timelines. Bind all parameters; the names below are placeholders.

| Access pattern | Query path / index |
| --- | --- |
| All expenses involving a user | `expense_involvement WHERE user_id = :user_id ORDER BY incurred_at DESC, expense_id DESC`; `expense_involvement_user_timeline_idx` |
| A user's expenses within a group | `expense_involvement WHERE user_id = :user_id AND group_id = :group_id`; `expense_involvement_user_group_timeline_idx` |
| Settlements paid to a user | `settlements WHERE paid_to_user_id = :user_id ORDER BY settled_at DESC, id DESC`; `settlements_recipient_idx` |
| Settlements paid by a user | `settlements WHERE paid_by_user_id = :user_id ORDER BY settled_at DESC, id DESC`; `settlements_sender_idx` |
| Expenses in a group | `expenses WHERE group_id = :group_id ORDER BY incurred_at DESC, id DESC`; `expenses_group_timeline_idx` |
| Balances owed by or to a user | Indexed scans of `pair_balances` by its low and high user IDs |

For standalone expenses, use `WHERE group_id IS NULL` with the group timeline index. To find expenses entered by a user on behalf of others, use `expenses.created_by_user_id` with `expenses_creator_timeline_idx`.

A user's financially involved expense feed, including expenses they paid but did not share:

```sql
SELECT e.*
FROM expense_involvement i JOIN expenses e ON e.id = i.expense_id
WHERE i.user_id = :user_id
  AND (i.incurred_at, i.expense_id) < (:cursor_incurred_at, :cursor_expense_id)
ORDER BY i.incurred_at DESC, i.expense_id DESC LIMIT :limit;
```

Omit the cursor predicate for the first page. Add `AND i.group_id = :group_id` for a group-specific feed.

Balances **owed by** one user, across standalone and grouped records:

```sql
SELECT currency_code, user_high_id AS other_user_id, net_minor AS amount_minor
FROM pair_balances WHERE user_low_id = :user_id AND net_minor > 0
UNION ALL
SELECT currency_code, user_low_id AS other_user_id, -net_minor AS amount_minor
FROM pair_balances WHERE user_high_id = :user_id AND net_minor < 0;
```

Balances **owed to** one user:

```sql
SELECT currency_code, user_high_id AS other_user_id, -net_minor AS amount_minor
FROM pair_balances WHERE user_low_id = :user_id AND net_minor < 0
UNION ALL
SELECT currency_code, user_low_id AS other_user_id, net_minor AS amount_minor
FROM pair_balances WHERE user_high_id = :user_id AND net_minor > 0;
```

`pair_balances` already nets the same pair across standalone and grouped expenses within each currency. Groups are not accounting boundaries. A group expense subtotal can be derived from allocations on its tagged expenses, but settlements apply to the users' total balance rather than to an individual group.

## Auth integration

The stateless auth session is separate from `users`. After verified Google sign-in, resolve the Google subject through `user_identities`, creating a user and identity atomically on first sign-in. Use that app user ID for every financial foreign key. Do not assume Better Auth's stateless `user.id` is durable. The API implements this resolution during verified Google profile mapping and includes a protected app-user ID in its encrypted session. A request-local user-create hook injects that ID after Better Auth filters provider fields; clients cannot set it. `/api/me` returns the durable app profile.

## API additions

- `expenses`, `settlements`, and `groups` carry incrementing `version` fields. Writes require the last-read version; membership changes use the group version.
- `audit_events` retains financial before/after JSON snapshots, actor, action and time. Creation events also hold actor/resource-scoped idempotency keys and normalized request hashes. Audit records do not reference deletable financial rows, so deletions retain history and retry receipts.
- `mutation_guards` supplies database constraints for atomic authorization/version assertions. Successful batches delete their assertion row; failed assertions roll back the complete mutation.
- `lookup_limits` stores one current minute counter per caller for exact email discovery. An expression index supports normalized email lookup; email is deliberately not unique because it is not identity.
- End-of-batch balance assertions reject non-integer or out-of-safe-range final balances for every affected pair. Application money calculations use integer arithmetic and validate aggregate sums before writes.

See [API contracts](api.md) for permissions, snapshot redaction, pagination, and correction rules. Financial history is retained indefinitely in this version.

## Operations

Run `npm run db:migrate` for a fresh local D1 database. This initial migration was edited in place because there is no live financial data; anyone who applied its earlier grouped-only draft locally must discard that local D1 state before rerunning it. Before deployment, create a D1 database, replace the placeholder `database_id` in `wrangler.jsonc`, and apply the migration remotely. No production database or API is created by the schema alone.
