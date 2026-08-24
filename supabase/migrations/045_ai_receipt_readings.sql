-- ============================================================
-- Forensics for CFE receipt reads.
--
-- A live quote went out at 8 paneles / $75,500 when the bill called for
-- 6 / $62,400. The bill was a clean PDF and the arithmetic downstream was
-- correct, so the wrong number had to have entered at the vision call —
-- but the model's raw response was never persisted anywhere, and
-- `ai_usage_log` keeps only token counts. There was nothing left to read.
-- The misread could be reasoned about and fixed structurally, never
-- actually reproduced.
--
-- So every vision read now leaves its raw response behind, next to what
-- the code made of it. The point is the pair: `parsed` shows the
-- extraction the quote was built on, `raw_response` shows what the model
-- actually said, and the difference between them is where a future bug
-- will be. One without the other answers half the question.
--
-- Not new personal data: the response carries the same consumption,
-- tariff, service number and city already stored on the contact and in
-- `conversations.ai_meter_state`. The images themselves are never stored
-- here — only the text the model returned about them.
--
-- Append-only and expected to be pruned. An active account writes one
-- row per bill read, so this grows with receipts rather than with
-- messages; `idx_ai_receipt_readings_created` exists for the delete.
--
-- RLS: admin+ read, mirroring ai_usage_log — a reading is a customer's
-- billing data, not something an agent needs to browse. Writes come from
-- the service role (webhook + Cotizador route both log through the admin
-- client on purpose), so there is no INSERT policy for `authenticated`.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_receipt_readings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Both nullable: the Cotizador reads a bill for a person standing at a
  -- browser, with no conversation and sometimes no contact behind it.
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- Which surface asked for the read. 'auto_reply' is the WhatsApp bot,
  -- 'cotizador' the internal quote generator.
  source          text NOT NULL CHECK (source IN ('auto_reply', 'cotizador')),
  provider        text NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model           text NOT NULL,
  -- Exactly what came back, before any parsing. Null only when the
  -- provider returned nothing at all (the HTTP failure is logged to the
  -- console with its body); the row still records that a read happened.
  raw_response    text,
  -- The ReceiptExtraction the raw response became, or null when it could
  -- not be parsed at all — which is itself the finding.
  parsed          jsonb,
  -- Lifted out of `parsed` so the common audit ("which reads landed on a
  -- surprising average?") is a scan, not a JSON traversal on every row.
  promedio_kwh    integer,
  -- WhatsApp media ids behind the read, so a row can be traced back to
  -- the images the customer actually sent. Empty for the Cotizador,
  -- which uploads files directly and has no media ids.
  media_ids       text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ai_receipt_readings IS
  'Forensics for CFE vision reads: the model raw response next to the extraction the quote was built on. Append-only, service-role writes, admin+ read. Prune by created_at.';

-- The audit read: this account's reads, newest first.
CREATE INDEX IF NOT EXISTS idx_ai_receipt_readings_account_created
  ON ai_receipt_readings(account_id, created_at DESC);

-- "Show me every bill this customer sent" — the query you actually run
-- when someone disputes the number on their proposal.
CREATE INDEX IF NOT EXISTS idx_ai_receipt_readings_contact_created
  ON ai_receipt_readings(contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

-- For the retention job, which deletes by age across all accounts.
CREATE INDEX IF NOT EXISTS idx_ai_receipt_readings_created
  ON ai_receipt_readings(created_at);

ALTER TABLE ai_receipt_readings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_receipt_readings_select ON ai_receipt_readings;
CREATE POLICY ai_receipt_readings_select ON ai_receipt_readings FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- No INSERT/UPDATE/DELETE policies for `authenticated`: written only by
-- the service role, and never mutated after the fact — a forensic log
-- that can be edited is not one.
