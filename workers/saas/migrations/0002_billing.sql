PRAGMA foreign_keys = ON;

CREATE TABLE wallets (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  polar_customer_id TEXT UNIQUE,
  balance_micros INTEGER NOT NULL DEFAULT 0 CHECK(balance_micros >= 0),
  held_micros INTEGER NOT NULL DEFAULT 0 CHECK(held_micros >= 0),
  frozen INTEGER NOT NULL DEFAULT 0 CHECK(frozen IN (0, 1)),
  last_purchase_micros INTEGER CHECK(last_purchase_micros IS NULL OR last_purchase_micros > 0),
  low_balance_notice INTEGER NOT NULL DEFAULT 0 CHECK(low_balance_notice IN (0, 5, 20)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE model_rates (
  id TEXT PRIMARY KEY NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'openai',
  input_micros_per_million INTEGER NOT NULL CHECK(input_micros_per_million >= 0),
  cached_input_micros_per_million INTEGER NOT NULL CHECK(cached_input_micros_per_million >= 0),
  output_micros_per_million INTEGER NOT NULL CHECK(output_micros_per_million >= 0),
  markup_bps INTEGER NOT NULL CHECK(markup_bps >= 0),
  minimum_charge_micros INTEGER NOT NULL CHECK(minimum_charge_micros >= 0),
  effective_at INTEGER NOT NULL,
  ends_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK(ends_at IS NULL OR ends_at > effective_at)
);
CREATE UNIQUE INDEX model_rates_one_open_version
  ON model_rates(model) WHERE ends_at IS NULL;
CREATE INDEX model_rates_lookup_idx ON model_rates(model, effective_at, ends_at);

CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('purchase', 'usage', 'refund', 'dispute', 'expiry', 'adjustment')),
  amount_micros INTEGER NOT NULL CHECK(amount_micros != 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_id TEXT,
  model TEXT,
  rate_version_id TEXT REFERENCES model_rates(id) ON DELETE RESTRICT,
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens INTEGER CHECK(cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
  wholesale_micros INTEGER CHECK(wholesale_micros IS NULL OR wholesale_micros >= 0),
  exact INTEGER NOT NULL DEFAULT 1 CHECK(exact IN (0, 1)),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX ledger_entries_user_created_idx ON ledger_entries(user_id, created_at DESC, id DESC);
CREATE INDEX ledger_entries_kind_created_idx ON ledger_entries(kind, created_at);

CREATE TABLE holds (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  rate_version_id TEXT NOT NULL REFERENCES model_rates(id) ON DELETE RESTRICT,
  amount_micros INTEGER NOT NULL CHECK(amount_micros > 0),
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens > 0),
  status TEXT NOT NULL CHECK(status IN ('active', 'settled', 'released')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  settled_at INTEGER
);
CREATE INDEX holds_active_expiry_idx ON holds(status, expires_at);
CREATE INDEX holds_user_status_idx ON holds(user_id, status);

CREATE TABLE absorbed_costs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  rate_version_id TEXT NOT NULL REFERENCES model_rates(id) ON DELETE RESTRICT,
  wholesale_micros INTEGER NOT NULL CHECK(wholesale_micros >= 0),
  forgone_retail_micros INTEGER NOT NULL CHECK(forgone_retail_micros >= 0),
  reason TEXT NOT NULL CHECK(reason IN ('upstream_error', 'client_abort', 'settle_failed', 'reaped_unknown')),
  exact INTEGER NOT NULL CHECK(exact IN (0, 1)),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens INTEGER CHECK(cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX absorbed_costs_created_idx ON absorbed_costs(created_at);
CREATE INDEX absorbed_costs_user_created_idx ON absorbed_costs(user_id, created_at);

CREATE TABLE credit_lots (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL UNIQUE,
  original_micros INTEGER NOT NULL CHECK(original_micros > 0),
  remaining_micros INTEGER NOT NULL CHECK(remaining_micros >= 0),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX credit_lots_expiry_idx ON credit_lots(user_id, expires_at, created_at);

CREATE TABLE processed_webhooks (
  event_id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  processed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE purchase_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX purchase_attempts_user_time_idx ON purchase_attempts(user_id, created_at);
CREATE INDEX purchase_attempts_ip_time_idx ON purchase_attempts(ip_hash, created_at);
