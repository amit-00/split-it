## `README.md`

# Splitwise-Style App — Design Package

This package documents the architecture and design decisions for a low-cost, scalable GCP build of a Splitwise-style app.

## Contents

1. **final_design_decisions.md**  
   Concrete technology choices (frontend, backend, auth, database, storage, async, notifications, observability, secrets, CI/CD, analytics, payments stance, region, data model, and security).

2. **high_level_design.md**  
   Architecture diagram (text), Firestore data model, and end-to-end flows (expense creation, file uploads via signed URLs, settlements, notifications), plus design considerations.

3. **cost_breakdown.md**  
   Ballpark monthly costs for _Tiny_, _Small_, and _Growing_ tiers, with notes on cost levers.

## Quick Start (Infra Summary)

- **Frontend**: Next.js on **Cloud Run** (SSR). Custom domain mapped directly to the Run service (managed SSL).
- **Auth**: OAuth/OIDC handled in the API (Cloud Run). Verify JWT on every request.
- **Backend**: Cloud Run for SSR + REST API + Workers; **Cloud Functions (2nd gen)** for Firestore/Storage triggers.
- **Database**: **Firestore (Native)** with append-only ledger and materialized balances per group.
- **Files**: **Cloud Storage** (private), access via **signed URLs**; lifecycle to Nearline for older receipts.
- **Async**: **Cloud Tasks** → Cloud Run Worker for notifications and recompute retries.
- **Notifications**: **FCM** push + Email provider (SendGrid/Mailgun/Postmark).
- **Observability**: Cloud Logging & Monitoring with 7–14d retention, trace sampling on errors.
- **Secrets**: Secret Manager.
- **CI/CD**: GitHub Actions → Cloud Build → Cloud Run/Functions.
- **Analytics**: GA4.
- **Region**: Single region (e.g., `us-central1`) for low latency/egress.

## Next Steps

- Add minimal **Firestore Rules** (deny-by-default; member-based reads/writes).
- Create **Next.js** Dockerfile and `gcloud run deploy` commands.
- Implement **expense → ledger → balances** transaction and a **greedy settlement** algorithm.
- Set **budgets & alerts**; cap Cloud Run `maxInstances` for cost safety.

---

_Maintained as living docs; update as the product evolves._
