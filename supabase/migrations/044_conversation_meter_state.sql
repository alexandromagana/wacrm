-- ============================================================
-- 044_conversation_meter_state.sql — multi-meter receipt batching
--
-- Some customers split one property's consumption across two or three
-- CFE meters, so the quote has to be built from the SUM of several
-- bills. Those bills arrive over multiple turns — "here's one", the bot
-- asks, "here are the other two" ten minutes later — so the readings
-- gathered so far have to outlive the turn that read them.
--
-- Held on the conversation rather than the contact on purpose: a batch
-- is a single quoting episode, not a durable fact about the customer.
-- It expires (see BATCH_TTL_MS in src/lib/ai/meters.ts) and is cleared
-- the moment its proposal goes out, so a receipt sent next month starts
-- a new project instead of being summed onto one already quoted.
--
-- Deliberately NOT a contact custom field: those render on the contact
-- card for the sales team, and this is internal bookkeeping — an
-- accumulator, not something a human should read or edit.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_meter_state JSONB;

COMMENT ON COLUMN conversations.ai_meter_state IS
  'Multi-meter receipt batch for the AI quoting flow, shaped as MeterState '
  'in src/lib/ai/meters.ts: the readings gathered so far (one per distinct '
  'CFE meter), the media already extracted, how many meters the customer '
  'said they have, and how many times the bot has asked. NULL means no open '
  'batch — the ordinary single-receipt customer never writes this column. '
  'Expires after 24h and is cleared once the combined proposal is sent.';
