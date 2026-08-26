-- Upstream spend that was never billed to anyone: failed streams, failed
-- settlements, reaped holds. Sustained growth here is a bug, not a cost of
-- doing business, and ABSORBED_ALERT_BPS is what alerts on it.
SELECT model, reason,
       COUNT(*) AS n,
       SUM(wholesale_micros)      / 1000000.0 AS absorbed_usd,
       SUM(forgone_retail_micros) / 1000000.0 AS forgone_retail_usd,
       datetime(MAX(created_at), 'unixepoch') AS most_recent
FROM absorbed_costs
GROUP BY model, reason
ORDER BY absorbed_usd DESC;
