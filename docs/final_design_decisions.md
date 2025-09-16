# Final Design Decisions

## Frontend

- **Next.js on Cloud Run** (SSR, no load balancer initially)
- Direct custom domain mapping with managed SSL
- Mobile app (Expo/React Native) later, after APIs are solid

## Authentication

- **Custom auth service on Cloud Run**
- OAuth providers (Google, Apple, email magic-link via email provider)
- Verify JWT/ID tokens on each request

## Backend Runtime / API

- **Cloud Run**: Main API, SSR, background workers (from Cloud Tasks)
- **Cloud Functions (2nd gen)**: Firestore/Storage triggers, cron handlers

## API Edge / Routing

- Direct calls to **Cloud Run** (no API Gateway initially)

## Database

- **Firestore (Native mode)**
- Append-only ledger + materialized balances strategy

## Caching

- None initially (design queries efficiently)

## File/Receipt Storage

- **Cloud Storage**
- Private by default, access via signed URLs
- Lifecycle policy to Nearline for old receipts

## Async Jobs & Scheduling

- **Cloud Tasks** for async background work
- **Cloud Scheduler** for periodic jobs

## Notifications

- **Firebase Cloud Messaging (FCM)** for push
- **Email provider** (SendGrid/Mailgun/Postmark) for invites/settlements

## Observability

- **Cloud Logging & Monitoring**, tuned for cost (7–14d retention, sampled traces)

## Secrets & Config

- **Secret Manager** for API keys, DB creds, email provider keys

## CI/CD

- **GitHub Actions** builds → **Cloud Build** → deploy to Cloud Run/Functions

## Analytics

- **Google Analytics 4 (GA4)** for product insights

## Payments

- No native payments; "mark-as-paid" UX only

## Region & Project Setup

- Single region deployment (e.g., `us-central1`)
- One project, IAM roles by principle of least privilege

## Security

- Verify auth on every request (JWTs)
- Strict Firestore security rules (only group members can read/write group/expense/settlement)
- Signed URLs for files
- Principle of least privilege IAM
