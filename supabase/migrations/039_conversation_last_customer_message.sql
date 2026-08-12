-- ============================================================
-- 039_conversation_last_customer_message.sql — last inbound-message time
--
-- WhatsApp's 24h customer-service window resets only on a message FROM
-- the customer — an agent's own reply never extends it. `last_message_at`
-- (migration 001) advances on both, so it can't answer "has this
-- conversation's window lapsed?" on its own; the inbox list needs a
-- column that tracks customer messages specifically, without loading
-- every conversation's full message history just to render a list row.
--
-- The thread view already computes this per-conversation from the
-- loaded `messages` array (see src/lib/whatsapp/session-window.ts). This
-- column lets the list do the same cheaply, from one query.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ;

COMMENT ON COLUMN conversations.last_customer_message_at IS
  'Timestamp of the most recent INBOUND (sender_type=customer) message only. '
  'Distinct from last_message_at, which also advances on agent replies. '
  'Drives the derived 24h WhatsApp session-window indicator — see '
  'src/lib/whatsapp/session-window.ts. NULL means this contact has never '
  'messaged in (fresh outbound-first conversation, or a historical row the '
  'backfill below found no customer messages for).';

-- One-time backfill so existing conversations don't all read NULL (and
-- therefore "no customer message yet") the moment this ships. Idempotent:
-- only touches rows still NULL, so re-running this migration is a no-op
-- the second time.
UPDATE conversations c
SET last_customer_message_at = (
  SELECT MAX(m.created_at)
  FROM messages m
  WHERE m.conversation_id = c.id
    AND m.sender_type = 'customer'
)
WHERE c.last_customer_message_at IS NULL;

-- Supports a future "Expired" quick-filter and keeps room for a
-- scheduled sweep later, without a second migration. Partial + scoped to
-- non-closed conversations, since a closed conversation's window is
-- irrelevant and never queried by either surface.
CREATE INDEX IF NOT EXISTS idx_conversations_last_customer_msg_open
  ON conversations(last_customer_message_at)
  WHERE status <> 'closed';
