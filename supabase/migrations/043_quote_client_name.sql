-- ============================================================
-- 043_quote_client_name.sql — the name a quote was addressed to.
--
-- Until now a quote took its customer name from `contacts.name` via
-- contact_id, which forced two things that aren't true in practice:
-- that every quoted lead already exists in the CRM (some arrive by
-- other channels), and that the name on their WhatsApp profile is the
-- one that belongs on a document (many are nicknames).
--
-- `client_name` is what was actually printed. It is set on every new
-- quote, whether or not a contact is linked, so the history can name
-- the recipient without joining a row that may not exist. contact_id
-- was already nullable — nothing about it changes here.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS client_name TEXT;

-- Backfill the quotes that predate the column from the contact they
-- were addressed to, so old and new rows read the same way.
UPDATE quotes q
SET client_name = c.name
FROM contacts c
WHERE q.contact_id = c.id
  AND q.client_name IS NULL
  AND c.name IS NOT NULL;
