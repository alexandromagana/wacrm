-- ============================================================
-- 054_ai_reasoning_effort.sql — choose how hard each AI job thinks,
-- and measure what that costs before switching models.
--
-- Three pieces, all for moving the bot off GPT-5.6 Terra/Luna onto
-- GPT-6.1 Sol (conversation) and GPT-6 Luna (bill reading) with the
-- numbers in hand rather than by feel.
--
--   1. ai_configs.reasoning_effort / vision_reasoning_effort
--
--      Until now the reasoning effort was decided in code from the
--      model's name: anything matching gpt-5/o-series got "none" on the
--      chat call, and the vision call sent nothing at all (so the
--      model's own default, "medium"). That stops working with GPT-6.1
--      Sol, which rejects "none" and "minimal" outright — its floor is
--      "low". Taught to send "none" to every gpt-6 the code would 400
--      every auto-reply; left alone it runs Sol at "medium" without
--      anyone having chosen that.
--
--      So the effort becomes part of the configuration, next to the
--      model it belongs to, and changing the pair is one UPDATE — the
--      same for rolling back. NULL keeps today's exact behaviour: the
--      name-based default for chat, nothing sent for vision.
--
--   2. ai_usage_log.cached_tokens / reasoning_tokens
--
--      The log kept prompt and completion totals only. Sol bills cached
--      input at half Terra's rate but adds reasoning tokens Terra never
--      spent, so the cost comparison turns on exactly the two numbers
--      that were not being kept. Nullable: older rows and providers that
--      do not report them stay NULL, which is not the same as zero.
--
--   3. ai_shadow_runs
--
--      With AI_SHADOW_ARMS set, every auto-reply turn is also answered
--      by each candidate model/effort on the very same system prompt and
--      messages — including the receipt, pricing and meter notes the bot
--      only ever sees live — and the answer is stored here, never sent.
--      A replay of old conversations cannot rebuild those notes; this is
--      how the quote turns get compared on equal terms.
--
--      Holds the reply text the customer received and what the
--      candidate would have said instead — the same class of data as
--      `messages`. Admin+ read, service-role writes, and meant to be
--      emptied once a comparison has been read.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. Reasoning effort per job.
-- ============================================================
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS reasoning_effort text
    CHECK (reasoning_effort IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS vision_reasoning_effort text
    CHECK (vision_reasoning_effort IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

COMMENT ON COLUMN ai_configs.reasoning_effort IS
  'OpenAI reasoning effort for the conversation model. NULL = code default ("none" for gpt-5/o-series, omitted otherwise). GPT-6.1 Sol rejects none/minimal.';
COMMENT ON COLUMN ai_configs.vision_reasoning_effort IS
  'OpenAI reasoning effort for receipt/image extraction. NULL = not sent (the model default).';

-- ============================================================
-- 2. The token counts that decide the cost comparison.
-- ============================================================
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS cached_tokens integer;

ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS reasoning_tokens integer;

COMMENT ON COLUMN ai_usage_log.cached_tokens IS
  'Prompt tokens served from the provider cache (billed at the cached rate). NULL = not reported.';
COMMENT ON COLUMN ai_usage_log.reasoning_tokens IS
  'Completion tokens spent reasoning, billed as output but never sent. NULL = not reported.';

-- ============================================================
-- 3. Shadow runs: what a candidate model would have answered.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_shadow_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id     uuid REFERENCES conversations(id) ON DELETE SET NULL,
  -- The candidate.
  model               text NOT NULL,
  reasoning_effort    text,
  -- What production actually sent on this turn, for the side by side.
  baseline_model      text NOT NULL,
  baseline_text       text NOT NULL,
  -- The parsed markers on both sides (handoff, lead status, quote sent,
  -- meters, hold, consumption verdict, package). A disagreement here is
  -- the comparison; the text is for reading it.
  baseline_markers    jsonb NOT NULL,
  -- Null when the candidate failed — `error` then says why.
  shadow_text         text,
  shadow_markers      jsonb,
  prompt_tokens       integer,
  cached_tokens       integer,
  completion_tokens   integer,
  reasoning_tokens    integer,
  baseline_latency_ms integer,
  shadow_latency_ms   integer,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ai_shadow_runs IS
  'Candidate model replies generated on live auto-reply turns and never sent (AI_SHADOW_ARMS). Service-role writes, admin+ read. Empty it after reading a comparison.';

CREATE INDEX IF NOT EXISTS idx_ai_shadow_runs_account_created
  ON ai_shadow_runs(account_id, created_at DESC);

ALTER TABLE ai_shadow_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_shadow_runs_select ON ai_shadow_runs;
CREATE POLICY ai_shadow_runs_select ON ai_shadow_runs FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- No INSERT/UPDATE/DELETE policies for `authenticated`: the bot writes
-- through the service role, and pruning is done by hand.
