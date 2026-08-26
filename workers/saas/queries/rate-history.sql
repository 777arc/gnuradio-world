-- Every rate version ever opened, current and closed. Pricing is versioned and
-- immutable because ledger rows cite the version they were billed under, so a
-- reprice appears here as a closed row beside its replacement, never as an edit.
SELECT id, model, provider,
       datetime(effective_at, 'unixepoch') AS effective,
       COALESCE(datetime(ends_at, 'unixepoch'), 'open') AS ends,
       input_micros_per_million, cached_input_micros_per_million,
       cache_write_micros_per_million, output_micros_per_million,
       markup_bps, minimum_charge_micros
FROM model_rates
ORDER BY model, effective_at;
