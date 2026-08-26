-- What each model earns. Usage rows are debits, so charged_usd negates them,
-- and wholesale_micros is what the upstream provider billed for the same
-- request. The margin column is the one that catches a model priced from
-- another model's rate row.
SELECT model,
       COUNT(*) AS requests,
       SUM(input_tokens) AS input_tokens,
       SUM(cached_input_tokens) AS cached_tokens,
       SUM(cache_write_tokens) AS cache_write_tokens,
       SUM(output_tokens) AS output_tokens,
       SUM(-amount_micros)   / 1000000.0 AS charged_usd,
       SUM(wholesale_micros) / 1000000.0 AS upstream_usd,
       SUM(-amount_micros - wholesale_micros) / 1000000.0 AS margin_usd,
       SUM(CASE WHEN exact = 0 THEN 1 ELSE 0 END) AS estimated_rows
FROM ledger_entries
WHERE kind = 'usage'
GROUP BY model
ORDER BY requests DESC;
