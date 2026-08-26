-- Balances. Returns customer email addresses: personal data, so treat the
-- result the way you would treat the accounts themselves. available_usd is what
-- a request is admitted against -- balance minus what outstanding holds reserve.
SELECT w.user_id, u.email,
       w.balance_micros / 1000000.0 AS balance_usd,
       w.held_micros    / 1000000.0 AS held_usd,
       (w.balance_micros - w.held_micros) / 1000000.0 AS available_usd,
       w.frozen,
       datetime(w.updated_at, 'unixepoch') AS updated
FROM wallets w JOIN "user" u ON u.id = w.user_id
ORDER BY balance_usd DESC;
