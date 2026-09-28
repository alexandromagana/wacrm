-- ============================================================
-- 053_rpc_execute_grants.sql
--
-- Stop anyone holding the anon key, and signed-in users who have no
-- reason to, from calling the SECURITY DEFINER functions in `public`.
--
-- PostgREST serves every function a role can EXECUTE at
-- /rest/v1/rpc/<name>, and the anon key ships in the browser bundle.
-- A SECURITY DEFINER function runs as postgres, past RLS, so unless
-- its body checks the caller, its grants are all the access control
-- it has. Supabase's advisor calls this
-- 0028_anon_security_definer_function_executable and
-- 0029_authenticated_security_definer_function_executable.
--
-- Postgres gives EXECUTE on every new function to PUBLIC, and
-- Supabase's default privileges grant it to anon, authenticated and
-- service_role by name as well. Migrations 018, 019, 022 and 036
-- revoked from PUBLIC only, which left the named anon grant in place;
-- 005, 017, 024, 027, 028, 029 and 052 revoked nothing. That is why
-- every REVOKE below names PUBLIC, anon and authenticated together.
--
-- What was reachable:
--   - _bcast_bump, recompute_broadcast_counts, claim_ai_reply_slot and
--     record_webhook_failure check nothing. Given a row's id, anyone
--     could rewrite a broadcast's counters, spend a conversation's AI
--     reply cap or switch off a webhook endpoint, all writes RLS keeps
--     for agents and admins.
--   - merge_duplicate_contacts and merge_duplicate_conversations take
--     no argument and run across every account. They find nothing to
--     merge today only because of the unique indexes from 022 and 036.
--   - touch_presence, redeem_invitation and the member RPCs from 018
--     check auth.uid() and the caller's role, so anon only ever got
--     'Unauthorized' back. Signed-in users keep them: the app calls
--     them with the user's session.
--   - The trigger functions can't run outside their trigger, and
--     Postgres checks EXECUTE when a trigger is created, not when it
--     fires, so the triggers are unaffected.
--
-- Left as they are: peek_invitation, which the /join page calls before
-- the visitor signs in (019 grants it to anon on purpose), and
-- is_account_member, which every RLS policy evaluates for anon too and
-- which only answers for auth.uid(). service_role keeps EXECUTE on
-- everything; the two functions the server calls with it are granted
-- again explicitly, as 031 did.
--
-- Only these functions in `public` are touched. gama_crm_auditor
-- reached them through PUBLIC too (051 revoked only its own grants)
-- and no longer does; its crm_audit_* functions keep their grants.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Server only — the AI auto-reply and webhook delivery call these
--    with the service-role client.
-- ============================================================
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(UUID, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.record_webhook_failure(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(UUID, INTEGER)
  TO service_role;

-- ============================================================
-- 2. Internal — called by the broadcast trigger (which runs as
--    postgres) or by hand from the SQL editor, never over the API.
-- ============================================================
REVOKE ALL ON FUNCTION public._bcast_bump(UUID, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_duplicate_contacts()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations()
  FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 3. Signed-in users — the presence heartbeat in the browser, and the
--    invitation and member routes, which forward the user's session.
-- ============================================================
REVOKE ALL ON FUNCTION public.touch_presence(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_presence(TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum)
  TO authenticated;

REVOKE ALL ON FUNCTION public.remove_account_member(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID)
  TO authenticated;

REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID)
  TO authenticated;

-- ============================================================
-- 4. Trigger functions — only their triggers run them.
-- ============================================================
REVOKE ALL ON FUNCTION public.broadcast_recipient_aggregate_trigger()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversations_reopen_auto_lost_deal()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deals_record_stage_event()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_conversation_assigned()
  FROM PUBLIC, anon, authenticated;
