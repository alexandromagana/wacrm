-- ============================================================
-- 049_inbound_media_storage.sql
--
-- Keep our own copy of every file a customer sends over WhatsApp.
--
-- Until now the webhook stored only Meta's media id
-- (`messages.media_url = /api/whatsapp/media/<id>`) and the media proxy
-- fetched the bytes from Meta on every view. Meta only keeps an inbound
-- media id downloadable for 7 days, so every receipt, photo and PDF a
-- customer sent stopped opening a week later — the bill a proposal was
-- priced from, gone from the contact's history. Everything we SEND was
-- never affected: chat-media / quote-assets already hold those.
--
-- The webhook now copies each inbound file into this bucket when it
-- arrives, and the proxy serves the copy first (src/lib/storage/
-- inbound-media.ts). `media_url` is unchanged, so no message row needs
-- rewriting.
--
-- Private, unlike every other bucket here. The others are public
-- because Meta has to fetch what we send by URL; nothing outside the CRM
-- ever needs to fetch what customers send us, and most of it is CFE
-- bills — name, address, service number.
--
-- Path convention (the media id alone, so the proxy can find a copy from
-- the URL it already has):
--   inbound-media/account-<account_id>/<meta_media_id>
--
-- No file_size_limit / allowed_mime_types: a customer can send any
-- document type up to Meta's 100 MB cap, and a copy the bucket refused
-- is a receipt lost in 7 days. The project's global upload limit still
-- applies.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. inbound-media storage bucket
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('inbound-media', 'inbound-media', FALSE, NULL, NULL)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================
-- 2. Storage RLS — members read their account's folder
--
-- Same account-folder predicate as chat-media (migration 023). Only a
-- SELECT policy: the webhook, the media proxy and the backfill script
-- all write through the service role, and a customer's receipt is not
-- something an agent should be able to overwrite from the browser.
-- ============================================================
DROP POLICY IF EXISTS "Members can read inbound media" ON storage.objects;
CREATE POLICY "Members can read inbound media"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'inbound-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
