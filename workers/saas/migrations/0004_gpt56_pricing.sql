ALTER TABLE model_rates
  ADD COLUMN cache_write_micros_per_million INTEGER NOT NULL DEFAULT 0
  CHECK(cache_write_micros_per_million >= 0);

ALTER TABLE ledger_entries
  ADD COLUMN cache_write_tokens INTEGER
  CHECK(cache_write_tokens IS NULL OR cache_write_tokens >= 0);

ALTER TABLE absorbed_costs
  ADD COLUMN cache_write_tokens INTEGER
  CHECK(cache_write_tokens IS NULL OR cache_write_tokens >= 0);
