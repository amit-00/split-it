# API Design Document

## Overview

This document outlines the technical design and implementation details for the Split-It API, a TypeScript/Node.js backend service running on Google Cloud Run. The API serves as the core backend for a Splitwise-style expense splitting application.

## Technology Stack

### Core Runtime

- **Runtime**: Node.js 20 LTS
- **Language**: TypeScript 5.x
- **Framework**: Express.js with TypeScript
- **Platform**: Google Cloud Run (containerized)

### Database & Storage

- **Primary Database**: Google Cloud Firestore (Native mode)
- **File Storage**: Google Cloud Storage
- **Caching**: None initially (optimize queries instead)

### Authentication & Security

- **JWT Library**: `jsonwebtoken` + `jose` for verification
- **OAuth Providers**: Google, Apple (via `passport` strategies)
- **Magic Links**: Custom implementation with email provider
- **Secrets Management**: Google Secret Manager

### Background Processing

- **Queue System**: Google Cloud Tasks
- **Workers**: Cloud Run instances processing tasks
- **Scheduling**: Google Cloud Scheduler

### Notifications

- **Push Notifications**: Firebase Cloud Messaging (FCM)
- **Email Service**: SendGrid/Mailgun/Postmark integration

### Development & Deployment

- **Package Manager**: npm/yarn
- **Build Tool**: TypeScript compiler + esbuild
- **Testing**: Jest + Supertest
- **Linting**: ESLint + Prettier
- **CI/CD**: GitHub Actions → Google Cloud Build

## API Architecture

### Service Structure

```
src/
├── controllers/          # Request handlers
├── services/            # Business logic
├── models/              # Data models and validation
├── middleware/          # Express middleware
├── routes/              # Route definitions
├── utils/               # Utility functions
├── types/               # TypeScript type definitions
├── config/              # Configuration management
└── workers/             # Background job processors
```

### Key Dependencies

```json
{
  "express": "^4.18.2",
  "cors": "^2.8.5",
  "helmet": "^7.1.0",
  "express-rate-limit": "^7.1.5",
  "jsonwebtoken": "^9.0.2",
  "jose": "^5.1.3",
  "passport": "^0.7.0",
  "passport-google-oauth20": "^2.0.0",
  "passport-apple": "^2.0.0",
  "@google-cloud/firestore": "^7.0.0",
  "@google-cloud/storage": "^7.7.0",
  "@google-cloud/tasks": "^5.0.0",
  "firebase-admin": "^12.0.0",
  "nodemailer": "^6.9.8",
  "joi": "^17.11.0",
  "winston": "^3.11.0",
  "dotenv": "^16.3.1"
}
```

## API Endpoints Design

### Authentication Endpoints

```
POST /auth/google          # Google OAuth callback
POST /auth/apple           # Apple OAuth callback
POST /auth/magic-link      # Send magic link email
POST /auth/verify-magic    # Verify magic link token
POST /auth/refresh         # Refresh JWT token
POST /auth/logout          # Invalidate token
```

### User Management

```
GET    /users/profile      # Get current user profile
PUT    /users/profile      # Update user profile
DELETE /users/account      # Delete user account
GET    /users/balances     # Get user's balances across all groups
```

### Group Management

```
GET    /groups             # List user's groups
POST   /groups             # Create new group
GET    /groups/:id         # Get group details
PUT    /groups/:id         # Update group settings
DELETE /groups/:id         # Delete group
POST   /groups/:id/invite  # Invite users to group
GET    /groups/:id/members # List group members
DELETE /groups/:id/members/:userId # Remove member
```

### Expense Management

```
GET    /groups/:id/expenses        # List group expenses
POST   /groups/:id/expenses        # Create new expense
GET    /expenses/:id               # Get expense details
PUT    /expenses/:id               # Update expense
DELETE /expenses/:id               # Delete expense
POST   /expenses/:id/receipt       # Upload receipt image
GET    /expenses/:id/receipt       # Get signed URL for receipt
```

### Settlement Management

```
GET    /groups/:id/settlements     # List group settlements
POST   /groups/:id/settlements     # Create settlement
PUT    /settlements/:id/confirm    # Mark settlement as paid
DELETE /settlements/:id            # Cancel settlement
GET    /groups/:id/balances        # Get group balance summary
```

### File Management

```
POST   /files/upload               # Get signed URL for file upload
GET    /files/:id/download         # Get signed URL for file download
DELETE /files/:id                  # Delete file
```

## Data Models

### User Model

```typescript
interface User {
  id: string;
  email: string;
  displayName: string;
  photoURL?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  preferences: {
    currency: string;
    timezone: string;
    notifications: {
      email: boolean;
      push: boolean;
    };
  };
}
```

### Group Model

```typescript
interface Group {
  id: string;
  name: string;
  description?: string;
  currency: string;
  createdBy: string;
  members: {
    [userId: string]: {
      role: "admin" | "member";
      joinedAt: Timestamp;
      status: "active" | "pending" | "inactive";
    };
  };
  settings: {
    allowMemberExpenses: boolean;
    requireApproval: boolean;
    defaultSplitType: "equal" | "percentage" | "exact";
  };
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### Expense Model

```typescript
interface Expense {
  id: string;
  groupId: string;
  title: string;
  description?: string;
  amount: number;
  currency: string;
  paidBy: string;
  splitType: "equal" | "percentage" | "exact";
  splits: {
    [userId: string]: {
      amount: number;
      percentage?: number;
      isPaid: boolean;
    };
  };
  category?: string;
  receiptUrl?: string;
  tags: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string;
}
```

### Ledger Entry Model

```typescript
interface LedgerEntry {
  id: string;
  groupId: string;
  type: "expense" | "settlement" | "adjustment";
  amount: number;
  currency: string;
  fromUserId: string;
  toUserId: string;
  expenseId?: string;
  settlementId?: string;
  description: string;
  createdAt: Timestamp;
  processedAt: Timestamp;
}
```

### Settlement Model

```typescript
interface Settlement {
  id: string;
  groupId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "cancelled";
  description?: string;
  createdAt: Timestamp;
  paidAt?: Timestamp;
  createdBy: string;
}
```

## Security Implementation

### Authentication Flow

1. **OAuth Providers**: Use Passport.js strategies for Google/Apple
2. **Magic Links**: Generate secure tokens with expiration
3. **JWT Tokens**: Signed with RS256, verified on every request
4. **Token Refresh**: Implement refresh token rotation

### Authorization Middleware

```typescript
// JWT verification middleware
const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
  // Verify JWT token from Authorization header
  // Extract user info and attach to request
};

// Group membership verification
const requireGroupMembership = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Verify user is member of the group
  // Check member status and permissions
};
```

### Firestore Security Rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Users can only access their own profile
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    // Groups: only members can read/write
    match /groups/{groupId} {
      allow read, write: if request.auth != null &&
        request.auth.uid in resource.data.members.keys();
    }

    // Expenses: only group members can access
    match /expenses/{expenseId} {
      allow read, write: if request.auth != null &&
        request.auth.uid in get(/databases/$(database)/documents/groups/$(resource.data.groupId)).data.members.keys();
    }
  }
}
```

## Error Handling

### Error Response Format

```typescript
interface APIError {
  error: {
    code: string;
    message: string;
    details?: any;
    timestamp: string;
    requestId: string;
  };
}
```

### Error Categories

- **400 Bad Request**: Validation errors, malformed requests
- **401 Unauthorized**: Invalid or missing authentication
- **403 Forbidden**: Insufficient permissions
- **404 Not Found**: Resource not found
- **409 Conflict**: Business logic conflicts (duplicate settlements)
- **429 Too Many Requests**: Rate limiting
- **500 Internal Server Error**: Unexpected server errors

## Background Processing

### Cloud Tasks Integration

```typescript
// Task queue configuration
const taskClient = new CloudTasksClient();
const queuePath = "projects/PROJECT_ID/locations/LOCATION/queues/QUEUE_NAME";

// Enqueue tasks for:
// - Balance recalculation after expense changes
// - Settlement algorithm execution
// - Push notification sending
// - Email notification sending
// - Receipt image processing
```

### Worker Services

- **Balance Worker**: Recalculates group balances after expense changes
- **Settlement Worker**: Runs settlement algorithms and creates settlement records
- **Notification Worker**: Sends push notifications and emails
- **File Processing Worker**: Handles image optimization and thumbnail generation

## Performance Considerations

### Database Optimization

- **Denormalization**: Store materialized balances in groups
- **Batch Operations**: Use Firestore batch writes for related operations
- **Indexing**: Create composite indexes for common query patterns
- **Pagination**: Implement cursor-based pagination for large datasets

### Caching Strategy

- **No Redis initially**: Optimize Firestore queries instead
- **Future consideration**: Add Memorystore Redis for frequently accessed data

### Rate Limiting

```typescript
const rateLimit = require("express-rate-limit");

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP",
});
```

## Monitoring & Observability

### Logging Strategy

```typescript
import winston from "winston";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    // Cloud Logging integration
  ],
});
```

### Metrics to Track

- **API Performance**: Response times, error rates, throughput
- **Business Metrics**: Expense creation rate, settlement completion rate
- **Infrastructure**: Cloud Run instance count, Firestore read/write operations
- **User Behavior**: Active users, group creation rate, feature usage

### Health Checks

```
GET /health              # Basic health check
GET /health/ready        # Readiness probe (database connectivity)
GET /health/live         # Liveness probe (service is running)
```

## Deployment Configuration

### Cloud Run Configuration

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: split-it-api
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/maxScale: "100"
        autoscaling.knative.dev/minScale: "0"
    spec:
      containerConcurrency: 1000
      containers:
        - image: gcr.io/PROJECT_ID/split-it-api
          ports:
            - containerPort: 8080
          env:
            - name: NODE_ENV
              value: "production"
            - name: FIRESTORE_PROJECT_ID
              value: "PROJECT_ID"
          resources:
            limits:
              memory: "1Gi"
              cpu: "1000m"
```

### Environment Variables

```bash
NODE_ENV=production
PORT=8080
FIRESTORE_PROJECT_ID=your-project-id
JWT_SECRET_KEY=secret-manager-reference
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
FCM_SERVER_KEY=secret-manager-reference
EMAIL_PROVIDER_API_KEY=secret-manager-reference
```

## Testing Strategy

### Unit Tests

- **Services**: Business logic functions
- **Models**: Data validation and transformation
- **Utilities**: Helper functions and calculations

### Integration Tests

- **API Endpoints**: Full request/response cycle
- **Database Operations**: Firestore read/write operations
- **External Services**: Mock external API calls

### Test Structure

```
tests/
├── unit/
│   ├── services/
│   ├── models/
│   └── utils/
├── integration/
│   ├── api/
│   └── database/
└── e2e/
    └── workflows/
```

## Future Considerations

### Scalability Enhancements

- **Load Balancer**: Add Cloud Load Balancer for global distribution
- **CDN**: Implement Cloud CDN for static assets
- **Caching**: Add Redis for frequently accessed data
- **Database Sharding**: Consider Firestore multi-region for global users

### Feature Additions

- **Real-time Updates**: WebSocket support for live expense updates
- **Advanced Analytics**: BigQuery integration for business intelligence
- **Payment Integration**: Stripe/PayPal integration for actual payments
- **Mobile API**: Dedicated mobile-optimized endpoints

### Performance Optimizations

- **GraphQL**: Consider GraphQL for flexible data fetching
- **Database Optimization**: Advanced indexing and query optimization
- **Background Processing**: More sophisticated job scheduling and retry logic

---

This API design provides a solid foundation for building a scalable, maintainable expense splitting application using modern TypeScript/Node.js practices on Google Cloud Platform.
