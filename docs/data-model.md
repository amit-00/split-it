# Data model

The application uses Cloudflare D1 (SQLite). `migrations/0000_expense_model.sql` defines the durable model; authentication still uses Better Auth's stateless cookies.

## Relationships

- `users` holds the app's durable user ID and display profile. `user_identities` maps `(provider, provider_subject)` to it. The Google subject (`sub`) is the identity key; email is mutable profile data and must not be used to join financial records.
- `groups` has one immutable currency and many `group_members`. A member who leaves gets `left_at`; keep the row so old expenses and settlements still refer to that person.
- `expenses` belongs to a group. `expense_payments` lists who funded it; `expense_shares` lists who consumed it. Both can contain the same user. `expense_allocations` records the resulting debtor-to-creditor edges. `expense_involvement` is an indexed, trigger-maintained feed of every payer or participant.
- `settlements` records actual payments between two members of a group. `pair_balances` is the current net per pair and group, maintained by database triggers. Positive `net_minor` means `user_low_id` owes `user_high_id`; negative means the reverse. Zero rows may remain and are ignored in reads.

All monetary values are integer minor units in the group's currency (for example, 1234 CAD cents). Never use floating point for money. Keep currencies separate when aggregating balances. IDs should be generated in the application (UUID or ULID); timestamps are Unix milliseconds.

## Write rules

Create or edit an expense and all its child rows in one database transaction. Validate that every payer and participant belongs to the group, including members who have since left for historical edits. Require:

1. `SUM(expense_payments.amount_minor) = expenses.amount_minor`.
2. `SUM(expense_shares.amount_minor) = expenses.amount_minor`.
3. For each user, net position is payments minus shares. Match negative positions to positive positions deterministically (for example, in user ID order) and write the matching edges to `expense_allocations`. The sum of allocations must equal the sum of all positive net positions.

For example, Alice pays 3000 cents for a three-person equal split. Shares are 1000 cents each; allocations are Bob → Alice 1000 and Carol → Alice 1000. If Bob also pays 1000 on another expense, his payment and share both participate in its netting.

The database checks row-level constraints, foreign keys, pair-balance updates, and expense-involvement updates. The cross-row sums above require application validation in the same transaction as the writes. Replacing allocations or correcting a settlement updates `pair_balances` through triggers; financial edits should also write an audit trail before user-facing edit features are exposed. Use `idempotency_key` on settlements to avoid recording a retried payment twice.

A settlement from A to B reduces A's debt to B. If the payment is larger than the debt, the signed pair balance crosses zero and B then owes A. When exposing balances, decide whether to allow or reject such overpayments at the API layer.

## Frequent reads

The indexes support keyset pagination on timeline queries. Bind all parameters; `:user_id`, `:group_id`, and `:limit` below are placeholders.

| Access pattern | Query path / index |
| --- | --- |
| All expenses involving a user | `expense_involvement WHERE user_id = :user_id ORDER BY incurred_at DESC, expense_id DESC`; `expense_involvement_user_timeline_idx` |
| Settlements paid to a user | `settlements WHERE paid_to_user_id = :user_id ORDER BY settled_at DESC, id DESC`; `settlements_recipient_idx` |
| Settlements paid by a user | `settlements WHERE paid_by_user_id = :user_id ORDER BY settled_at DESC, id DESC`; `settlements_sender_idx` |
| Expenses in a group | `expenses WHERE group_id = :group_id ORDER BY incurred_at DESC, id DESC`; `expenses_group_timeline_idx` |
| Balances owed by / to a user | Two indexed scans of `pair_balances` for the low and high endpoints; `pair_balances_low_idx` and `pair_balances_high_idx` |

Expenses financially involving one user, including those they paid but did not share. If “my expenses” should mean expenses the user entered for others, query `expenses.created_by_user_id` using `expenses_creator_timeline_idx`. Pass the last row’s timestamp and ID as the next page cursor:

```sql
SELECT e.*
FROM expense_involvement i JOIN expenses e ON e.id = i.expense_id
WHERE i.user_id = :user_id
  AND (i.incurred_at, i.expense_id) < (:cursor_incurred_at, :cursor_expense_id)
ORDER BY i.incurred_at DESC, i.expense_id DESC LIMIT :limit;
```

For the first page, omit the cursor predicate.

Balances **owed by** one user, per group (join `groups` on `group_id` when displaying the currency):

```sql
SELECT group_id, user_high_id AS other_user_id, net_minor AS amount_minor
FROM pair_balances WHERE user_low_id = :user_id AND net_minor > 0
UNION ALL
SELECT group_id, user_low_id AS other_user_id, -net_minor AS amount_minor
FROM pair_balances WHERE user_high_id = :user_id AND net_minor < 0;
```

Balances **owed to** one user:

```sql
SELECT group_id, user_high_id AS other_user_id, -net_minor AS amount_minor
FROM pair_balances WHERE user_low_id = :user_id AND net_minor < 0
UNION ALL
SELECT group_id, user_low_id AS other_user_id, net_minor AS amount_minor
FROM pair_balances WHERE user_high_id = :user_id AND net_minor > 0;
```

For an overall balance against another user, sum **signed** amounts across groups of the same currency before classifying who owes whom:

```sql
WITH mine AS (
  SELECT b.user_high_id AS other_user_id, g.currency_code, b.net_minor AS signed_owed_minor
  FROM pair_balances b JOIN groups g ON g.id = b.group_id
  WHERE b.user_low_id = :user_id
  UNION ALL
  SELECT b.user_low_id AS other_user_id, g.currency_code, -b.net_minor AS signed_owed_minor
  FROM pair_balances b JOIN groups g ON g.id = b.group_id
  WHERE b.user_high_id = :user_id
)
SELECT other_user_id, currency_code, SUM(signed_owed_minor) AS signed_owed_minor
FROM mine GROUP BY other_user_id, currency_code
HAVING SUM(signed_owed_minor) <> 0;
```

A positive result is owed **by** the user; a negative result is owed **to** the user. Never sum amounts across different currencies.

## Auth integration

The current stateless auth session is separate from `users`. On a verified Google sign-in, resolve the Google provider subject through `user_identities`, creating a `users` row and identity row atomically on first sign-in. Use the resulting app user ID for every financial foreign key. Do not assume Better Auth's stateless session `user.id` is the durable app user ID. API routes for this resolution and for groups/expenses/settlements are future work.

## Operations

Run `npm run db:migrate` for a local D1 database. Before deployment, create a D1 database and replace the placeholder `database_id` in `wrangler.jsonc`; then apply the migration remotely. This schema adds no production database or live API by itself.
