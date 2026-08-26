-- Price gpt-5.6-terra at ten times gpt-5.6-luna, which is what the deployed
-- catalog has charged since terra's row was repriced by hand. 0005 opened terra
-- by copying luna's rate, and that copy is a placeholder that undercharges by an
-- order of magnitude — so a database built from these migrations alone came up
-- billing terra at luna's price while production billed ten times it.
--
-- The multiple is the only number here: rates stay private service data, so this
-- derives terra's four components from whatever row is open for luna rather than
-- naming any of them, exactly as 0005 does. markup_bps and minimum_charge_micros
-- are copied rather than multiplied — one is a percentage and the other a floor,
-- and both match luna in the deployed catalog.
--
-- It is a no-op wherever terra is already ten times luna, so production keeps
-- the hand-set row its ledger entries cite rather than gaining an identical
-- version. Where it does act, it closes the placeholder and opens a new version
-- instead of updating a row in place, per the rule 0005 states.
--
-- On a database where 0005 ran in this same second, the placeholder's ends_at
-- cannot be now (CHECK(ends_at > effective_at)), so it closes one second out and
-- terra prices at the placeholder for that one second. Nothing reads a rate that
-- early in a fresh database; on any real one, unixepoch() already exceeds the
-- placeholder's effective_at and the new version opens immediately.
UPDATE model_rates
SET ends_at = max(unixepoch(), effective_at + 1)
WHERE model = 'gpt-5.6-terra'
  AND ends_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM model_rates luna
    WHERE luna.model = 'gpt-5.6-luna'
      AND luna.ends_at IS NULL
      AND model_rates.input_micros_per_million = 10 * luna.input_micros_per_million
      AND model_rates.cached_input_micros_per_million = 10 * luna.cached_input_micros_per_million
      AND model_rates.cache_write_micros_per_million = 10 * luna.cache_write_micros_per_million
      AND model_rates.output_micros_per_million = 10 * luna.output_micros_per_million
  );

INSERT INTO model_rates (
  id, model, provider, input_micros_per_million,
  cached_input_micros_per_million, cache_write_micros_per_million,
  output_micros_per_million, markup_bps, minimum_charge_micros, effective_at
)
SELECT
  'gpt-5.6-terra-10x-' || (SELECT max(ends_at) FROM model_rates WHERE model = 'gpt-5.6-terra'),
  'gpt-5.6-terra', luna.provider,
  10 * luna.input_micros_per_million,
  10 * luna.cached_input_micros_per_million,
  10 * luna.cache_write_micros_per_million,
  10 * luna.output_micros_per_million,
  luna.markup_bps, luna.minimum_charge_micros,
  (SELECT max(ends_at) FROM model_rates WHERE model = 'gpt-5.6-terra')
FROM model_rates luna
WHERE luna.model = 'gpt-5.6-luna'
  AND luna.ends_at IS NULL
  -- Only ever reprices a terra that exists and has just been closed above;
  -- never opens the model in a database that 0005 left without it.
  AND EXISTS (SELECT 1 FROM model_rates WHERE model = 'gpt-5.6-terra')
  AND NOT EXISTS (SELECT 1 FROM model_rates WHERE model = 'gpt-5.6-terra' AND ends_at IS NULL);
