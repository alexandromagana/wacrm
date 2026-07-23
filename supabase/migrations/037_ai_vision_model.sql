-- ============================================================
-- 037_ai_vision_model.sql — separate model for receipt/image reading
--
-- The AI assistant runs two very different jobs on one model setting:
--
--   1. Conversation — long business prompt, nuanced instruction
--      following, tone. Benefits from a stronger (often reasoning)
--      model.
--   2. Vision extraction — read a bill image, emit ~150 tokens of
--      strict JSON. A small, fast, non-reasoning vision model does this
--      well and cheaply.
--
-- Forcing both onto one model is a false trade-off, and it actively
-- broke reads: pointing the account at a reasoning model made every
-- receipt extraction truncate, because reasoning tokens are billed
-- against the same output budget and get spent before any JSON is
-- emitted.
--
-- `vision_model` is nullable and NULL means "use `model`" — existing
-- accounts keep today's exact behaviour until someone opts in. Not a
-- separate key: the same `api_key` (same provider) serves both calls.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS vision_model text;

COMMENT ON COLUMN ai_configs.vision_model IS
  'Optional model override for image/receipt extraction. NULL = use `model`. Same provider + api_key as the chat model.';
