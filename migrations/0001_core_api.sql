ALTER TABLE expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE settlements ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE groups ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
CREATE INDEX users_email_lookup_idx ON users(lower(trim(email)));

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('expense','settlement')),
  entity_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('create','update','delete','detach')),
  created_at INTEGER NOT NULL,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  idempotency_key TEXT,
  request_hash TEXT,
  CHECK (before_json IS NOT NULL OR after_json IS NOT NULL),
  CHECK ((idempotency_key IS NULL AND request_hash IS NULL) OR (action = 'create' AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL)),
  UNIQUE (actor_user_id, entity_type, idempotency_key)
);
CREATE INDEX audit_entity_idx ON audit_events(entity_type,entity_id,id DESC);

-- A failed assertion aborts the whole D1 batch, including its earlier statements.
CREATE TABLE mutation_guards (
  id TEXT PRIMARY KEY,
  allowed INTEGER NOT NULL CONSTRAINT mutation_allowed CHECK (allowed = 1),
  current INTEGER NOT NULL CONSTRAINT mutation_current CHECK (current = 1),
  money_safe INTEGER NOT NULL DEFAULT 1 CONSTRAINT money_overflow CHECK (money_safe = 1)
);
CREATE TABLE lookup_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
