-- The credits catalog: every model the editor can offer, at the price the
-- customer actually pays. The stored columns are wholesale, so this applies
-- markup_bps the same way priceUsage() does in src/pricing.ts, ceiling and all.
-- minimum_charge is per request rather than per million, so it stays its own
-- column.
SELECT model,
       (input_micros_per_million        * (10000 + markup_bps) + 9999) / 10000 / 1000000.0 AS input_usd_per_1m,
       (cached_input_micros_per_million * (10000 + markup_bps) + 9999) / 10000 / 1000000.0 AS cached_usd_per_1m,
       (cache_write_micros_per_million  * (10000 + markup_bps) + 9999) / 10000 / 1000000.0 AS cache_write_usd_per_1m,
       (output_micros_per_million       * (10000 + markup_bps) + 9999) / 10000 / 1000000.0 AS output_usd_per_1m,
       markup_bps / 100.0 AS markup_pct,
       minimum_charge_micros / 1000000.0 AS min_charge_usd
FROM model_rates
WHERE ends_at IS NULL
ORDER BY model;
