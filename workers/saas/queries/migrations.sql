-- Which migrations this database has applied. A migration that failed partway
-- is absent here, so its statements can be re-run once the file is fixed.
SELECT id, name, applied_at FROM d1_migrations ORDER BY id;
