# Expense Core Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Keep independent file ownership when delegating.

**Goal:** Implement the approved expense-sharing API without deployment.
**Architecture:** Hono middleware authenticates durable Google users and validates requests. Domain routes execute guarded atomic D1 batches; SQL triggers retain balance ownership. Audit snapshots also provide creation retry receipts.
**Tech Stack:** TypeScript, Hono, Better Auth 1.7.4, Workers/D1, Node test runner, Miniflare.
**Spec:** ../specs/2026-09-21-expense-core-design.md

## Global constraints

Registered users only; CAD/USD integer cents; creator-only expense writes; recorder-only settlement writes; owner-managed groups. No new runtime dependency except Hono, no deployment, no UI features. Tests precede each implementation. Full approved behavior is binding; write-time authorization, rollback, audit visibility and retry semantics are essential.

## File responsibilities

- src/index.ts: Hono entry, auth forwarding, middleware/errors/health/assets.
- src/auth.ts: Google provider and trusted durable identity mapping.
- src/api.ts: shared request types, validation, pagination, version and transaction guards.
- src/money.ts: pure splitting and deterministic net allocations.
- src/expenses.ts: expense CRUD/feed/history.
- src/settlements.ts: settlement CRUD/feed/history and balances.
- src/groups.ts: group/member operations and exact lookup.
- src/records.ts: shared audit, idempotency and snapshot authorization.
- migrations/0001_core_api.sql: additive versions, audit, lookup counters, guard constraints.
- test/api.test.mjs and test/helpers.mjs: real Worker/D1 integration contract.
- test/money.test.mjs: executable pure money behavior checks.

## Task 1: Foundation and identity

- [ ] Install the approved Hono dependency; run baseline npm test and npm run check.
- [ ] Add integration fixture applying all migrations, seeded durable users and encrypted sessions with trusted appUserId claim.
- [ ] Failing tests: unauthenticated financial calls 401; invalid trusted ID 401; exact match returns public profile; email collision 409; foreign origin 403.
- [ ] Add Hono middleware and appUserId server-controlled session field. Resolve Google subject atomically on verified profile mapping; fail closed for legacy sessions.
- [ ] Add incremental migration and shared validation/errors/cursors/transaction guards.
- [ ] Run npm run check and node --test test/auth.test.mjs test/api.test.mjs after build.

## Task 2: Money calculations

- [ ] Write test/money.test.mjs before src/money.ts. Test literal CAD 1000 split across c,a,b => a334,b333,c333; reordered input same result; multiple payer net allocations; too few cents; duplicate IDs; mismatched sums; safe integer extremes.
- [ ] Run node --experimental-strip-types --test test/money.test.mjs to observe missing implementation failure.
- [ ] Expose allocateExpense(total:number,payments:Amount[],split:Split): {shares:Amount[],allocations:Allocation[]} with exported types. Amount={userId:string,amountMinor:number}; Split={type:'equal',userIds:string[]}|{type:'exact',shares:Amount[]}; Allocation={debtorUserId:string,creditorUserId:string,amountMinor:number}. Validate all integers and use BigInt internally for sums.
- [ ] Run the same command and typecheck; review the narrow diff.

## Task 3: Groups and user lookup

- [ ] Write real D1 tests for owner/member permissions, add/remove/rejoin, owner leave rejection, version conflicts, former member revocation and rate limits.
- [ ] Implement src/groups.ts using shared API helpers; membership mutations increment the parent group's version and require If-Match.
- [ ] Verify permission predicates and group version in the same batch as mutations; guard missing predicates with a constrained assertion insert, never treat zero updated rows as success.
- [ ] Test group deletion detaches expenses while leaving debt intact.

## Task 4: Expenses and audit

- [ ] Write tests creating the 3000-cent three-person example, exact/equal and multipayer splits, group/participant visibility and creator-only mutation.
- [ ] Implement expenses routes with full resource snapshots and monetary allocation writes.
- [ ] Write failing replay, changed-key-input and concurrent stale edit tests; implement scoped idempotency receipt fields on creation audit rows and required versions.
- [ ] Write history before/after redaction and after-deletion tests; implement snapshot-specific access.
- [ ] Verify deletes remove allocations before payments/shares/parent so triggers reverse balances.

## Task 5: Settlements and balances

- [ ] Test immediate 1500-cent settlement over 1000 debt => recipient owes payer 500; separate USD balance unchanged.
- [ ] Implement settlement mutations, idempotency/history/version protection using shared records helpers.
- [ ] Test changing an expense after settlement retains payment and recomputes debt, settlement edit/delete reversals and immutable parties/currency.
- [ ] Verify transaction rollback and safe integer cumulative bounds using D1 triggers.

## Task 6: Review and delivery

- [ ] Add README request examples, all route contracts, bounds and migration instructions.
- [ ] Run npm run check, npm test, git diff --check. No lint package exists: report explicitly.
- [ ] Independently review authorization, concurrency/idempotency, audit privacy and identity integration; fix findings with regression checks.
- [ ] Commit reviewed work on codex/expense-core; retain worktree for user review. Do not merge/push/deploy without request.
