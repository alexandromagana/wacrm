-- ============================================================
-- Keep Meta's reason a failed send actually failed.
--
-- The `statuses` webhook event carries an `errors` array on a `failed`
-- status, but nothing has ever read it — `messages.status` flips to
-- 'failed' and the reason is dropped on the floor. A red X in the inbox
-- with no explanation is undiagnosable both for a human and for the AI
-- agent. `status_error` gives the webhook handler somewhere to put it.
--
-- Nullable: most messages never fail, and older failed rows predate this
-- column, so they stay null rather than getting a fabricated reason.
-- ============================================================

alter table messages add column if not exists status_error text;
