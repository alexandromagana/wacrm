-- ============================================================
-- 038_push_subscriptions.sql — Web Push (VAPID) delivery targets
--
-- The inbox only told you about a new message if you happened to be
-- looking at it. With WhatsApp itself no longer available on the
-- owner's phone, that is a hard operational gap: messages arrive and
-- nobody is told. Web Push closes it — the browser/OS wakes up and
-- notifies even with the app fully closed.
--
-- One row per (person, device). A person signed in on a phone and two
-- office machines has three rows; every one of them must be pushed to,
-- so the endpoint cannot live on `profiles`.
--
-- Distinct from the `notifications` table (migration 027): that is the
-- in-app bell, written by a trigger and read inside the UI. This table
-- is transport — where to reach a browser that isn't open.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Owner of the device. FKs auth.users (not profiles) to match how
  -- `notifications.user_id` and `conversations.assigned_agent_id`
  -- already identify a person.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Push service URL issued by the browser vendor, plus the two client
  -- keys the payload is encrypted against. All three come verbatim from
  -- PushSubscription.toJSON() and are useless without each other.
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- Raw UA string, kept only so the settings screen can show a person
  -- something recognisable ("Chrome on Windows") when picking which
  -- device to revoke.
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Re-subscribing the same browser must update the existing row rather
  -- than accumulate duplicates that would each fire a notification.
  UNIQUE (account_id, user_id, endpoint)
);

-- Fan-out on an inbound message reads every subscription for an account
-- (unassigned conversation) or for one person (assigned conversation).
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_account
  ON push_subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- A device list is personal, not shared: teammates on the same account
-- must not see or revoke each other's devices. So visibility is keyed on
-- user_id alone — account_id is stored for the fan-out query, not for
-- access control. INSERT additionally checks account membership so a row
-- cannot be planted against an account the person doesn't belong to.
DROP POLICY IF EXISTS push_subscriptions_select ON push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_insert ON push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_update ON push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_delete ON push_subscriptions;

CREATE POLICY push_subscriptions_select ON push_subscriptions FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY push_subscriptions_insert ON push_subscriptions FOR INSERT
  WITH CHECK (auth.uid() = user_id AND is_account_member(account_id));
CREATE POLICY push_subscriptions_update ON push_subscriptions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY push_subscriptions_delete ON push_subscriptions FOR DELETE
  USING (auth.uid() = user_id);

COMMENT ON TABLE push_subscriptions IS
  'Web Push (VAPID) delivery targets — one row per person per browser/device.';

-- ============================================================
-- Per-person notification preferences
--
-- Which events are worth a buzz is a personal call, and it changes with
-- volume: the AI agent answers most messages on its own, so notifying
-- on every inbound is useful at first and noisy later. Storing this on
-- `profiles` (not on push_subscriptions) means muting an event mutes it
-- on all of that person's devices at once, which is what people expect.
--
-- Defaults to all-on so push is useful the moment a device registers;
-- turning things off is the informed, later decision.
-- ============================================================
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS push_prefs JSONB
    NOT NULL
    DEFAULT '{"message_received":true,"handoff":true,"conversation_assigned":true,"unanswered":true}'::JSONB;

COMMENT ON COLUMN profiles.push_prefs IS
  'Per-event Web Push opt-ins. Keys: message_received, handoff, conversation_assigned, unanswered.';

-- No new RLS policy needed: the existing `Users can view own profile` /
-- `Users can update own profile` policies (migration 001) already gate
-- this column, and the push fan-out reads it via service_role.
