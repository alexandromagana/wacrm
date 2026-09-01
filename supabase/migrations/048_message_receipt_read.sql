-- ============================================================
-- Remember which inbound media an AI turn has already looked at.
--
-- The burst resolver used to answer "has this receipt had its turn?"
-- with "is there a bot message newer than it?" — and that is not the
-- same question. A customer who types "Ok" and then takes twelve
-- seconds to attach their CFE bill splits the burst in two: the first
-- delivery replies to the text, its reply lands AFTER the PDF row, and
-- from then on every delivery reads that reply as proof the bill was
-- handled. The bill was never downloaded, the quote never went out, and
-- nothing about the conversation said so.
--
-- The honest signal is on the media row itself, written by the turn that
-- actually spent the vision call. Nullable, and older rows stay null:
-- only media from the last 90 seconds is ever eligible for a read, so
-- there is nothing to backfill.
-- ============================================================

alter table messages add column if not exists ai_receipt_read_at timestamptz;
