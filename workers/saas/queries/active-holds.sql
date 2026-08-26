-- Reservations still outstanding. A handful of recent rows is normal traffic.
-- Anything past its expiry means the minute cron that reaps holds is not
-- running, and that money stays unavailable to its owner until it is.
SELECT id, user_id, model, status,
       amount_micros / 1000000.0 AS held_usd,
       datetime(created_at, 'unixepoch') AS created,
       datetime(expires_at, 'unixepoch') AS expires,
       CASE WHEN expires_at < unixepoch() THEN 'EXPIRED - reaper is behind' ELSE 'ok' END AS state
FROM holds
WHERE status = 'active'
ORDER BY created_at;
