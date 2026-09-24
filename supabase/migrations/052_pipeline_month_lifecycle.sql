-- ============================================================
-- 052_pipeline_month_lifecycle.sql
--
-- Give deals and conversations an end.
--
-- Until now nothing ever closed: no deal was ever won or lost, the
-- board showed every deal since the account started, and a closed chat
-- stayed closed even when the customer wrote back. This migration adds
-- the bookkeeping the monthly pipeline view and the lifecycle sweep
-- (src/lib/lifecycle/) need:
--
--   * pipeline_stages.is_won / auto_close — which stage means "won"
--     (Signed), and which stages the sweep may close deals from.
--   * deals.closed_at / lost_reason / stage_changed_at / quoted_at,
--     kept by a trigger so every write path (API, automation engine,
--     quote-pdf, scripts) agrees. Moving a deal into an is_won stage
--     wins it; marking it won moves it there.
--   * deal_stage_events — history of stage/status changes. It cannot
--     be reconstructed later, so it starts now.
--   * conversations.closed_at / close_reason / close_suggested_* and a
--     trigger that reopens a closed chat when the customer writes (the
--     webhook bumps last_customer_message_at). A chat the sweep closed
--     (close_reason 'auto_*') also reopens the deal it lost.
--   * lifecycle_runs / lifecycle_actions — the sweep's throttle and
--     audit log.
--
-- Idempotent — safe to re-run. Backfills only run the first time a
-- column is added, so a re-run never undoes a setting changed in the UI.
-- ============================================================

-- ============================================================
-- 1. pipeline_stages: is_won, auto_close
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pipeline_stages' AND column_name = 'is_won'
  ) THEN
    ALTER TABLE pipeline_stages
      ADD COLUMN is_won BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN auto_close BOOLEAN NOT NULL DEFAULT FALSE;

    -- The last stage of each pipeline is where signed deals end up.
    UPDATE pipeline_stages s
    SET is_won = TRUE
    FROM (
      SELECT DISTINCT ON (pipeline_id) id
      FROM pipeline_stages
      ORDER BY pipeline_id, position DESC
    ) last_stage
    WHERE s.id = last_stage.id;

    -- One-time backfill by name; the pipeline settings toggle is the
    -- source of truth from here on.
    UPDATE pipeline_stages
    SET auto_close = TRUE
    WHERE name IN ('New Lead', 'Qualified', 'Proposal Sent');
  END IF;
END $$;

-- ============================================================
-- 2. deals: closed_at, lost_reason, stage_changed_at, quoted_at
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'deals' AND column_name = 'closed_at'
  ) THEN
    ALTER TABLE deals
      ADD COLUMN closed_at TIMESTAMPTZ,
      ADD COLUMN lost_reason TEXT CHECK (char_length(lost_reason) <= 200),
      ADD COLUMN stage_changed_at TIMESTAMPTZ,
      ADD COLUMN quoted_at TIMESTAMPTZ;

    -- Backfill without bumping updated_at on every deal.
    ALTER TABLE deals DISABLE TRIGGER set_updated_at;

    UPDATE deals SET stage_changed_at = COALESCE(updated_at, created_at);

    -- Quoted: has a proposal link, or sits in the proposal stage or past
    -- it. The date is the first document we sent in that chat (the
    -- proposal PDF), else when the deal last changed.
    UPDATE deals d
    SET quoted_at = COALESCE(
      (
        SELECT MIN(m.created_at)
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.account_id = d.account_id
          AND c.contact_id = d.contact_id
          AND m.sender_type IN ('bot', 'agent')
          AND m.content_type = 'document'
      ),
      d.updated_at
    )
    WHERE d.quote_url IS NOT NULL
       OR d.stage_id IN (
         SELECT id FROM pipeline_stages
         WHERE name IN ('Proposal Sent', 'Technical Visit', 'Signed')
       );

    UPDATE deals d
    SET status = 'won'
    FROM pipeline_stages s
    WHERE s.id = d.stage_id AND s.is_won AND d.status = 'open';

    UPDATE deals SET closed_at = updated_at WHERE status IN ('won', 'lost');

    ALTER TABLE deals ENABLE TRIGGER set_updated_at;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_deals_pipeline_created
  ON deals(pipeline_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deals_pipeline_closed
  ON deals(pipeline_id, closed_at) WHERE closed_at IS NOT NULL;

-- ============================================================
-- 3. deals lifecycle trigger
--
-- BEFORE INSERT OR UPDATE, so it only edits NEW — no recursion, and
-- every writer gets the same rules:
--   * stage changed (status untouched by the writer): into an is_won
--     stage → won; out of one while won → open.
--   * status changed (stage untouched): won → moved to the pipeline's
--     is_won stage; leaving won while in an is_won stage → moved back
--     to the closest stage before it.
--   * closed_at set when status enters won/lost, cleared when open.
--   * lost_reason only survives on lost deals.
--   * quoted_at stamped the first time a proposal link lands.
-- ============================================================
CREATE OR REPLACE FUNCTION deals_apply_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_new_won BOOLEAN;
  v_old_won BOOLEAN;
  v_target UUID;
BEGIN
  SELECT is_won INTO v_new_won FROM pipeline_stages WHERE id = NEW.stage_id;
  v_new_won := COALESCE(v_new_won, FALSE);

  IF TG_OP = 'INSERT' THEN
    NEW.stage_changed_at := COALESCE(NEW.stage_changed_at, now());
    IF v_new_won AND NEW.status <> 'won' THEN
      NEW.status := 'won';
    END IF;
    IF NEW.quote_url IS NOT NULL THEN
      NEW.quoted_at := COALESCE(NEW.quoted_at, now());
    END IF;
  ELSE
    IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
      NEW.stage_changed_at := now();
      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        SELECT is_won INTO v_old_won FROM pipeline_stages WHERE id = OLD.stage_id;
        IF v_new_won AND NEW.status <> 'won' THEN
          NEW.status := 'won';
        ELSIF NOT v_new_won AND COALESCE(v_old_won, FALSE) AND NEW.status = 'won' THEN
          NEW.status := 'open';
        END IF;
      END IF;
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status = 'won' AND NOT v_new_won THEN
        SELECT id INTO v_target
        FROM pipeline_stages
        WHERE pipeline_id = NEW.pipeline_id AND is_won
        ORDER BY position
        LIMIT 1;
      ELSIF OLD.status = 'won' AND NEW.status <> 'won' AND v_new_won THEN
        SELECT s.id INTO v_target
        FROM pipeline_stages s
        WHERE s.pipeline_id = NEW.pipeline_id
          AND NOT s.is_won
          AND s.position < (SELECT position FROM pipeline_stages WHERE id = NEW.stage_id)
        ORDER BY s.position DESC
        LIMIT 1;
      END IF;
      IF v_target IS NOT NULL THEN
        NEW.stage_id := v_target;
        NEW.stage_changed_at := now();
      END IF;
    END IF;

    IF NEW.quote_url IS NOT NULL AND OLD.quote_url IS NULL THEN
      NEW.quoted_at := COALESCE(NEW.quoted_at, now());
    END IF;
  END IF;

  IF NEW.status = 'open' THEN
    NEW.closed_at := NULL;
  ELSIF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.closed_at := now();
  END IF;

  IF NEW.status <> 'lost' THEN
    NEW.lost_reason := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_apply_lifecycle ON deals;
CREATE TRIGGER deals_apply_lifecycle
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION deals_apply_lifecycle();

-- ============================================================
-- 4. deal_stage_events — stage/status history
-- ============================================================
CREATE TABLE IF NOT EXISTS deal_stage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  pipeline_id UUID,
  -- No FK on the stage ids: history outlives a deleted stage.
  from_stage_id UUID,
  to_stage_id UUID,
  from_status TEXT,
  to_status TEXT,
  lost_reason TEXT,
  changed_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deal_stage_events_deal
  ON deal_stage_events(deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deal_stage_events_account
  ON deal_stage_events(account_id, created_at DESC);

ALTER TABLE deal_stage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_stage_events_select ON deal_stage_events;
CREATE POLICY deal_stage_events_select ON deal_stage_events
  FOR SELECT USING (is_account_member(account_id));
-- No insert/update/delete policies: only the trigger below writes.

CREATE OR REPLACE FUNCTION deals_record_stage_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO deal_stage_events (
      account_id, deal_id, pipeline_id,
      from_stage_id, to_stage_id, from_status, to_status, lost_reason
    ) VALUES (
      NEW.account_id, NEW.id, NEW.pipeline_id,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage_id END, NEW.stage_id,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
      NEW.lost_reason
    );
  END IF;
  RETURN NULL;
END;
$$;

ALTER FUNCTION deals_record_stage_event() OWNER TO postgres;

DROP TRIGGER IF EXISTS deals_record_stage_event ON deals;
CREATE TRIGGER deals_record_stage_event
  AFTER INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION deals_record_stage_event();

-- ============================================================
-- 5. conversations: closed_at, close_reason, close suggestions
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'closed_at'
  ) THEN
    ALTER TABLE conversations
      ADD COLUMN closed_at TIMESTAMPTZ,
      ADD COLUMN close_reason TEXT CHECK (char_length(close_reason) <= 60),
      ADD COLUMN close_suggested_at TIMESTAMPTZ,
      ADD COLUMN close_suggested_reason TEXT CHECK (char_length(close_suggested_reason) <= 60),
      ADD COLUMN close_suggestion_dismissed_at TIMESTAMPTZ;

    ALTER TABLE conversations DISABLE TRIGGER set_updated_at;

    UPDATE conversations
    SET closed_at = updated_at, close_reason = 'manual'
    WHERE status = 'closed';

    -- Automation templates used to bump last_message_at, floating every
    -- silent prospect back to the top of the inbox after each follow-up
    -- (src/lib/automations/meta-send.ts no longer does). Re-derive it
    -- from everything except those sends; a chat that only ever got
    -- automation templates keeps its current value.
    UPDATE conversations c
    SET last_message_at = x.last_at
    FROM (
      SELECT m.conversation_id, MAX(m.created_at) AS last_at
      FROM messages m
      WHERE NOT (m.sender_type = 'bot' AND m.content_type = 'template')
      GROUP BY m.conversation_id
    ) x
    WHERE x.conversation_id = c.id
      AND c.last_message_at IS DISTINCT FROM x.last_at;

    ALTER TABLE conversations ENABLE TRIGGER set_updated_at;
  END IF;
END $$;

-- ============================================================
-- 6. conversations lifecycle trigger
--
-- The webhook advances last_customer_message_at on every inbound
-- message, so reopening here is atomic with the message landing —
-- before the AI reply, automations or recordQuoteOnDeal run.
-- ============================================================
CREATE OR REPLACE FUNCTION conversations_apply_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.last_customer_message_at IS NOT NULL
     AND NEW.last_customer_message_at > COALESCE(OLD.last_customer_message_at, '-infinity'::timestamptz) THEN
    IF OLD.status = 'closed' AND NEW.status = 'closed' THEN
      NEW.status := 'open';
    END IF;
    NEW.close_suggested_at := NULL;
    NEW.close_suggested_reason := NULL;
  END IF;

  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    NEW.closed_at := now();
    NEW.close_reason := COALESCE(NEW.close_reason, 'manual');
    NEW.close_suggested_at := NULL;
    NEW.close_suggested_reason := NULL;
  ELSIF NEW.status <> 'closed' AND OLD.status = 'closed' THEN
    NEW.closed_at := NULL;
    NEW.close_reason := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_apply_lifecycle ON conversations;
CREATE TRIGGER conversations_apply_lifecycle
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_apply_lifecycle();

-- A chat the sweep closed lost its deal with an auto_* reason; when the
-- chat reopens, so does that deal. A deal someone lost by hand stays
-- lost — a person decided that.
CREATE OR REPLACE FUNCTION conversations_reopen_auto_lost_deal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE deals
  SET status = 'open'
  WHERE id = (
    SELECT d.id
    FROM deals d
    WHERE d.account_id = NEW.account_id
      AND d.contact_id = NEW.contact_id
      AND d.status = 'lost'
      AND d.lost_reason LIKE 'auto\_%'
    ORDER BY d.closed_at DESC NULLS LAST, d.created_at DESC
    LIMIT 1
  );
  RETURN NULL;
END;
$$;

ALTER FUNCTION conversations_reopen_auto_lost_deal() OWNER TO postgres;

-- Not `UPDATE OF status`: the webhook never sets status — the BEFORE
-- trigger above does — and a column list only matches columns named in
-- the UPDATE statement itself.
DROP TRIGGER IF EXISTS conversations_reopen_auto_lost_deal ON conversations;
CREATE TRIGGER conversations_reopen_auto_lost_deal
  AFTER UPDATE ON conversations
  FOR EACH ROW
  WHEN (
    OLD.status = 'closed'
    AND NEW.status <> 'closed'
    AND OLD.close_reason LIKE 'auto\_%'
  )
  EXECUTE FUNCTION conversations_reopen_auto_lost_deal();

-- ============================================================
-- 7. Lifecycle sweep bookkeeping (src/lib/lifecycle/)
-- ============================================================
CREATE TABLE IF NOT EXISTS lifecycle_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  source TEXT NOT NULL CHECK (source IN ('cron', 'script')),
  -- floor(epoch / interval) for cron runs: a duplicate slot means
  -- another run already took this window.
  slot BIGINT UNIQUE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  summary JSONB
);

-- Service role only: RLS on, no policies.
ALTER TABLE lifecycle_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS lifecycle_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES lifecycle_runs(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('remind', 'close', 'suggest')),
  reason TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('done', 'skipped', 'failed')),
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_actions_conversation
  ON lifecycle_actions(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_actions_account
  ON lifecycle_actions(account_id, created_at DESC);

ALTER TABLE lifecycle_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lifecycle_actions_select ON lifecycle_actions;
CREATE POLICY lifecycle_actions_select ON lifecycle_actions
  FOR SELECT USING (is_account_member(account_id, 'admin'));
