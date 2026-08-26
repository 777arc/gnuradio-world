-- Offer gpt-5.6-terra alongside gpt-5.6-luna in the credits catalog. A model is
-- only selectable while it has an open rate version: /api/models lists the open
-- rows and /api/chat refuses anything without one.
--
-- Rates stay private service data, so this migration names none: it opens
-- terra's first version by copying the rate currently open for luna. Reprice it
-- the ordinary way once terra's own upstream cost is known — close this row with
-- ends_at and insert a new version; never update a row a ledger entry cites.
-- Nothing is inserted in an environment where luna has no open version.
INSERT INTO model_rates (
  id, model, provider, input_micros_per_million,
  cached_input_micros_per_million, cache_write_micros_per_million,
  output_micros_per_million, markup_bps, minimum_charge_micros, effective_at
)
SELECT
  'gpt-5.6-terra-2026-08-26', 'gpt-5.6-terra', provider, input_micros_per_million,
  cached_input_micros_per_million, cache_write_micros_per_million,
  output_micros_per_million, markup_bps, minimum_charge_micros, unixepoch()
FROM model_rates
WHERE model = 'gpt-5.6-luna' AND ends_at IS NULL;
