-- ============================================================
-- 050_storage_no_public_listing.sql
--
-- Stop anyone holding the anon key from listing chat-media,
-- quote-assets and flow-media.
--
-- Migrations 016, 023 and 041 gave each of those public buckets a
-- SELECT policy on storage.objects that checked nothing but the bucket
-- id, for every role. A public bucket never needed it:
-- `/object/public/<path>` serves a known path without consulting RLS,
-- and that is all Meta and the inbox ever use. What the policies did
-- grant was listing — anyone with the anon key, which ships in the
-- browser bundle, could enumerate every proposal we sent and every CFE
-- receipt the Cotizador archived. Supabase's advisor calls this
-- 0025_public_bucket_allows_listing.
--
-- Replaced rather than dropped: `remove()` needs SELECT (the composer
-- cleaning up an unsent attachment, deleting a quote template) and the
-- Cotizador downloads its template through the authenticated endpoint.
-- Members keep all of that for their own account's folder — the same
-- predicate the write policies already use, and every object in these
-- buckets lives under one.
--
-- Public links are unaffected: every URL already stored in
-- `messages.media_url`, `deals` and `quotes.output_url` keeps working.
--
-- `avatars` stays as it is. Its policy has the same shape, but a list of
-- profile pictures is not customer data, and its upsert upload relies
-- on that SELECT.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. chat-media
-- ============================================================
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can read chat media" ON storage.objects;
CREATE POLICY "Members can read chat media"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- 2. quote-assets
-- ============================================================
DROP POLICY IF EXISTS "Quote assets are publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can read quote assets" ON storage.objects;
CREATE POLICY "Members can read quote assets"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'quote-assets'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- 3. flow-media — also the legacy per-user folder, which migration
--    020 kept writable for media uploaded before account sharing.
-- ============================================================
DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can read flow media" ON storage.objects;
CREATE POLICY "Members can read flow media"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );
