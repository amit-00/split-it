PRAGMA foreign_keys = ON;

-- Money is stored as integer minor units. Each group has one currency.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Bind an app user to the stable subject issued by an identity provider.
-- Email is profile data, not an identity key.
CREATE TABLE user_identities (
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (provider, provider_subject)
);
CREATE INDEX user_identities_user_idx ON user_identities(user_id);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency_code TEXT NOT NULL CHECK (currency_code GLOB '[A-Z][A-Z][A-Z]'),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Retain historical memberships after a person leaves the group.
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  left_at INTEGER CHECK (left_at IS NULL OR left_at >= joined_at),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user_idx ON group_members(user_id, group_id);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  description TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  incurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (group_id, created_by_user_id) REFERENCES group_members(group_id, user_id)
);
CREATE INDEX expenses_group_timeline_idx ON expenses(group_id, incurred_at DESC, id DESC);
CREATE INDEX expenses_creator_timeline_idx ON expenses(created_by_user_id, incurred_at DESC, id DESC);

-- Payments and shares sum independently to expenses.amount_minor.
-- A participant can have both a payment and a share.
CREATE TABLE expense_payments (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (expense_id, user_id)
);
CREATE INDEX expense_payments_user_idx ON expense_payments(user_id, expense_id);

CREATE TABLE expense_shares (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (expense_id, user_id)
);
CREATE INDEX expense_shares_user_idx ON expense_shares(user_id, expense_id);

-- Net each expense's payments minus shares into debtor/creditor pairs.
CREATE TABLE expense_allocations (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  debtor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creditor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  CHECK (debtor_user_id <> creditor_user_id),
  PRIMARY KEY (expense_id, debtor_user_id, creditor_user_id)
);
CREATE INDEX expense_allocations_debtor_idx ON expense_allocations(debtor_user_id, expense_id);
CREATE INDEX expense_allocations_creditor_idx ON expense_allocations(creditor_user_id, expense_id);

CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  paid_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  paid_to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  settled_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  note TEXT,
  idempotency_key TEXT UNIQUE,
  CHECK (paid_by_user_id <> paid_to_user_id),
  FOREIGN KEY (group_id, paid_by_user_id) REFERENCES group_members(group_id, user_id),
  FOREIGN KEY (group_id, paid_to_user_id) REFERENCES group_members(group_id, user_id),
  FOREIGN KEY (group_id, recorded_by_user_id) REFERENCES group_members(group_id, user_id)
);
CREATE INDEX settlements_recipient_idx ON settlements(paid_to_user_id, settled_at DESC, id DESC);
CREATE INDEX settlements_sender_idx ON settlements(paid_by_user_id, settled_at DESC, id DESC);
CREATE INDEX settlements_group_timeline_idx ON settlements(group_id, settled_at DESC, id DESC);

-- Positive net_minor: user_low_id owes user_high_id. Negative: the reverse.
-- This is a projection of expense_allocations and settlements, maintained by triggers.
CREATE TABLE pair_balances (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  net_minor INTEGER NOT NULL,
  CHECK (user_low_id < user_high_id),
  PRIMARY KEY (group_id, user_low_id, user_high_id),
  FOREIGN KEY (group_id, user_low_id) REFERENCES group_members(group_id, user_id),
  FOREIGN KEY (group_id, user_high_id) REFERENCES group_members(group_id, user_id)
);
CREATE INDEX pair_balances_low_idx ON pair_balances(user_low_id, group_id, user_high_id);
CREATE INDEX pair_balances_high_idx ON pair_balances(user_high_id, group_id, user_low_id);

-- One row per user involved in an expense, whether payer, participant, or both.
-- This supports a user timeline without sorting their entire expense history.
CREATE TABLE expense_involvement (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  group_id TEXT NOT NULL,
  incurred_at INTEGER NOT NULL,
  PRIMARY KEY (expense_id, user_id),
  FOREIGN KEY (group_id, user_id) REFERENCES group_members(group_id, user_id)
);
CREATE INDEX expense_involvement_user_timeline_idx
  ON expense_involvement(user_id, incurred_at DESC, expense_id DESC);

-- Reject moving an existing expense to a different group: allocations have
-- already been projected into that group's balances.
CREATE TRIGGER expenses_no_group_move BEFORE UPDATE OF group_id ON expenses
BEGIN
  SELECT RAISE(ABORT, 'expense group cannot change');
END;

CREATE TRIGGER allocations_insert AFTER INSERT ON expense_allocations
BEGIN
  INSERT INTO pair_balances (group_id, user_low_id, user_high_id, net_minor)
  SELECT e.group_id, min(NEW.debtor_user_id, NEW.creditor_user_id),
         max(NEW.debtor_user_id, NEW.creditor_user_id),
         CASE WHEN NEW.debtor_user_id < NEW.creditor_user_id THEN NEW.amount_minor ELSE -NEW.amount_minor END
  FROM expenses e WHERE e.id = NEW.expense_id
  ON CONFLICT (group_id, user_low_id, user_high_id)
  DO UPDATE SET net_minor = pair_balances.net_minor + excluded.net_minor;
END;

CREATE TRIGGER allocations_delete AFTER DELETE ON expense_allocations
BEGIN
  INSERT INTO pair_balances (group_id, user_low_id, user_high_id, net_minor)
  SELECT e.group_id, min(OLD.debtor_user_id, OLD.creditor_user_id),
         max(OLD.debtor_user_id, OLD.creditor_user_id),
         CASE WHEN OLD.debtor_user_id < OLD.creditor_user_id THEN -OLD.amount_minor ELSE OLD.amount_minor END
  FROM expenses e WHERE e.id = OLD.expense_id
  ON CONFLICT (group_id, user_low_id, user_high_id)
  DO UPDATE SET net_minor = pair_balances.net_minor + excluded.net_minor;
END;

CREATE TRIGGER allocations_update AFTER UPDATE ON expense_allocations
BEGIN
  INSERT INTO pair_balances (group_id, user_low_id, user_high_id, net_minor)
  SELECT e.group_id, min(OLD.debtor_user_id, OLD.creditor_user_id),
         max(OLD.debtor_user_id, OLD.creditor_user_id),
         CASE WHEN OLD.debtor_user_id < OLD.creditor_user_id THEN -OLD.amount_minor ELSE OLD.amount_minor END
  FROM expenses e WHERE e.id = OLD.expense_id
  ON CONFLICT (group_id, user_low_id, user_high_id)
  DO UPDATE SET net_minor = pair_balances.net_minor + excluded.net_minor;
  INSERT INTO pair_balances (group_id, user_low_id, user_high_id, net_minor)
  SELECT e.group_id, min(NEW.debtor_user_id, NEW.creditor_user_id),
         max(NEW.debtor_user_id, NEW.creditor_user_id),
         CASE WHEN NEW.debtor_user_id < NEW.creditor_user_id THEN NEW.amount_minor ELSE -NEW.amount_minor END
  FROM expenses e WHERE e.id = NEW.expense_id
  ON CONFLICT (group_id, user_low_id, user_high_id)
  DO UPDATE SET net_minor = pair_balances.net_minor + excluded.net_minor;
END;

CREATE TRIGGER settlements_insert AFTER INSERT ON settlements
BEGIN
  INSERT INTO pair_balances (group_id, user_low_id, user_high_id, net_minor)
  VALUES (NEW.group_id, min(NEW.paid_by_user_id, NEW.paid_to_user_id),
          max(NEW.paid_by_user_id, NEW.paid_to_user_id),
          CASE WHEN NEW.paid_by_user_id < NEW.paid_to_user_id THEN -NEW.amount_minor ELSE NEW.amount_minor END)
  ON CONFLICT (group_id, user_low_id, user_high_id)
  DO UPDATE SET net_minor = pair_balances.net_minor + excluded.net_minor;
END;

CREATE TRIGGER settlements_delete AFTER DELETE ON settlements
BEGIN
  INSERT INTO pair_balances (group_id, user_low_id, user_high_id, net_minor)
  VALUES (OLD.group_id, min(OLD.paid_by_user_id, OLD.paid_to_user_id),
          max(OLD.paid_by_user_id, OLD.paid_to_user_id),
          CASE WHEN OLD.paid_by_user_id < OLD.paid_to_user_id THEN OLD.amount_minor ELSE -OLD.amount_minor END)
  ON CONFLICT (group_id, user_low_id, user_high_id)
  DO UPDATE SET net_minor = pair_balances.net_minor + excluded.net_minor;
END;

CREATE TRIGGER settlements_update AFTER UPDATE ON settlements
BEGIN
  INSERT INTO pair_balances (group_id, user_low_id, user_high_id, net_minor)
  VALUES (OLD.group_id, min(OLD.paid_by_user_id, OLD.paid_to_user_id),
          max(OLD.paid_by_user_id, OLD.paid_to_user_id),
          CASE WHEN OLD.paid_by_user_id < OLD.paid_to_user_id THEN OLD.amount_minor ELSE -OLD.amount_minor END)
  ON CONFLICT (group_id, user_low_id, user_high_id)
  DO UPDATE SET net_minor = pair_balances.net_minor + excluded.net_minor;
  INSERT INTO pair_balances (group_id, user_low_id, user_high_id, net_minor)
  VALUES (NEW.group_id, min(NEW.paid_by_user_id, NEW.paid_to_user_id),
          max(NEW.paid_by_user_id, NEW.paid_to_user_id),
          CASE WHEN NEW.paid_by_user_id < NEW.paid_to_user_id THEN -NEW.amount_minor ELSE NEW.amount_minor END)
  ON CONFLICT (group_id, user_low_id, user_high_id)
  DO UPDATE SET net_minor = pair_balances.net_minor + excluded.net_minor;
END;

-- Keep the expense feed projection in sync with both source tables.
CREATE TRIGGER payments_involvement_insert AFTER INSERT ON expense_payments
BEGIN
  INSERT OR IGNORE INTO expense_involvement(expense_id, user_id, group_id, incurred_at)
  SELECT e.id, NEW.user_id, e.group_id, e.incurred_at FROM expenses e WHERE e.id = NEW.expense_id;
END;

CREATE TRIGGER payments_involvement_delete AFTER DELETE ON expense_payments
BEGIN
  DELETE FROM expense_involvement
  WHERE expense_id = OLD.expense_id AND user_id = OLD.user_id
    AND NOT EXISTS (SELECT 1 FROM expense_payments WHERE expense_id = OLD.expense_id AND user_id = OLD.user_id)
    AND NOT EXISTS (SELECT 1 FROM expense_shares WHERE expense_id = OLD.expense_id AND user_id = OLD.user_id);
END;

CREATE TRIGGER payments_involvement_update AFTER UPDATE ON expense_payments
BEGIN
  DELETE FROM expense_involvement
  WHERE expense_id = OLD.expense_id AND user_id = OLD.user_id
    AND NOT EXISTS (SELECT 1 FROM expense_payments WHERE expense_id = OLD.expense_id AND user_id = OLD.user_id)
    AND NOT EXISTS (SELECT 1 FROM expense_shares WHERE expense_id = OLD.expense_id AND user_id = OLD.user_id);
  INSERT OR IGNORE INTO expense_involvement(expense_id, user_id, group_id, incurred_at)
  SELECT e.id, NEW.user_id, e.group_id, e.incurred_at FROM expenses e WHERE e.id = NEW.expense_id;
END;

CREATE TRIGGER shares_involvement_insert AFTER INSERT ON expense_shares
BEGIN
  INSERT OR IGNORE INTO expense_involvement(expense_id, user_id, group_id, incurred_at)
  SELECT e.id, NEW.user_id, e.group_id, e.incurred_at FROM expenses e WHERE e.id = NEW.expense_id;
END;

CREATE TRIGGER shares_involvement_delete AFTER DELETE ON expense_shares
BEGIN
  DELETE FROM expense_involvement
  WHERE expense_id = OLD.expense_id AND user_id = OLD.user_id
    AND NOT EXISTS (SELECT 1 FROM expense_payments WHERE expense_id = OLD.expense_id AND user_id = OLD.user_id)
    AND NOT EXISTS (SELECT 1 FROM expense_shares WHERE expense_id = OLD.expense_id AND user_id = OLD.user_id);
END;

CREATE TRIGGER shares_involvement_update AFTER UPDATE ON expense_shares
BEGIN
  DELETE FROM expense_involvement
  WHERE expense_id = OLD.expense_id AND user_id = OLD.user_id
    AND NOT EXISTS (SELECT 1 FROM expense_payments WHERE expense_id = OLD.expense_id AND user_id = OLD.user_id)
    AND NOT EXISTS (SELECT 1 FROM expense_shares WHERE expense_id = OLD.expense_id AND user_id = OLD.user_id);
  INSERT OR IGNORE INTO expense_involvement(expense_id, user_id, group_id, incurred_at)
  SELECT e.id, NEW.user_id, e.group_id, e.incurred_at FROM expenses e WHERE e.id = NEW.expense_id;
END;

CREATE TRIGGER expenses_involvement_date_update AFTER UPDATE OF incurred_at ON expenses
BEGIN
  UPDATE expense_involvement SET incurred_at = NEW.incurred_at WHERE expense_id = NEW.id;
END;
