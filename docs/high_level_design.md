# High Level Design

## Architecture Overview

```text
[Users: Web / (Later) Mobile]
           │
           ▼
  HTTPS (custom domain, managed SSL)
           │
           ▼
[Cloud Run: Next.js SSR + REST API]
           │
   ┌───────┴────────┐
   │                │
   ▼                ▼
[Firestore]   [Cloud Storage]
   ▲                ▲
   │                │  (private buckets, signed URLs)
   │                │
   └───[Cloud Functions (2nd gen)]  ← triggers on Firestore/Storage
                 │
                 │  (on expense/settlement → update ledger & balances)
                 ▼

Async processing:
[Cloud Tasks queue] ──▶ [Cloud Run: Worker service]

Notifications:
- FCM Push (from API/Worker)
- Email provider (SendGrid/Mailgun/Postmark)

Supporting services:
- Observability: Cloud Logging & Monitoring (trimmed retention)
- Secrets: Secret Manager
- CI/CD: GitHub Actions + Cloud Build
- Analytics: GA4
```

## Data Model (Firestore)

- `users/{userId}`: profile, balances
- `groups/{groupId}`: members, settings
- `expenses/{expenseId}`: amount, payer, splits
- `ledgers/{groupId}/entries/{entryId}`: append-only, per transaction
- `settlements/{settlementId}`: records of repayment
- Materialized balances in `groups/{id}/balances/{userId}`

## Flows

- **Expense creation** → API (Cloud Run) → Firestore write → Function updates ledger & balances
- **File upload** → signed URL (Cloud Run) → Cloud Storage
- **Notification** → Task enqueues → Worker sends push/email

---

# Design Considerations

## Scalability

- Cloud Run & Functions scale to zero and elastically with traffic
- Firestore auto-scales for reads/writes; denormalized data for cheap reads
- Async background jobs decouple heavy work

## Cost Efficiency

- No LB initially (avoid fixed costs)
- Firestore chosen over Cloud SQL (zero idle cost)
- Logging retention tuned for cost savings
- Lifecycle rules for storage (move old receipts to Nearline)

## Security

- Authentication handled in Cloud Run (OAuth, JWT verification)
- Firestore rules enforce least privilege access
- Signed URLs for file access (no public buckets)
- Secrets in Secret Manager (not env files)

## Maintainability

- Single API service (Cloud Run) keeps API surface unified
- Functions only for event-driven cases (avoids sprawl)
- CI/CD automated with GitHub Actions + Cloud Build
- Observability tuned for actionable insights

## Future Flexibility

- Add Load Balancer + Cloud CDN when global traffic grows
- Introduce Redis (Memorystore) if Firestore reads become costly
- Export data to BigQuery for advanced analytics
- Add payment provider integration if required
