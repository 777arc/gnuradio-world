-- The original plan contradicted itself: its product decision named OpenAI,
-- while its stack section named OpenRouter. The deployed service uses OpenAI
-- directly. Preserve rate versions and their ledger references while changing
-- the provider boundary recorded on those immutable rows.
UPDATE model_rates SET provider = 'openai' WHERE provider = 'openrouter';
