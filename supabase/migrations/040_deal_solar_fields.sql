-- ============================================================
-- 040_deal_solar_fields.sql — solar-install fields on deals
--
-- A solar deal isn't tracked by a single "expected close date": the
-- dates the team actually works against are the technical visit (a
-- specific date AND time — someone has to physically be there) and
-- the installation date, after which the crew watches for the CFE
-- paperwork to clear so the panels can be switched on. The system
-- size (panel count) and a link back to the quote that was sent to
-- the customer round out what an agent needs at a glance.
--
-- `expected_close_date` (migration 001) is intentionally LEFT IN
-- PLACE. It's dropped from the UI in favour of these, but keeping
-- the column means existing values survive and the field can be
-- brought back without another migration.
--
-- All nullable: deals are created long before any of this is known,
-- and the automation/AI layer is expected to fill them in over time.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS panel_count INTEGER,
  ADD COLUMN IF NOT EXISTS technical_visit_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS installation_date DATE,
  ADD COLUMN IF NOT EXISTS quote_url TEXT;

-- A negative panel count is always a data error, whether it came from
-- a typo in the form or a bad AI extraction. Zero stays legal: it
-- reads as "quoted, system size not settled yet".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deals_panel_count_check' AND conrelid = 'deals'::regclass
  ) THEN
    ALTER TABLE deals
      ADD CONSTRAINT deals_panel_count_check
      CHECK (panel_count IS NULL OR panel_count >= 0);
  END IF;
END $$;

-- Partial indexes: the rows worth finding fast are the scheduled ones
-- ("what visits are coming up?", "which installs are pending?"), and
-- those are the minority — NULL-heavy columns index far smaller this
-- way than a plain index over every deal.
CREATE INDEX IF NOT EXISTS idx_deals_technical_visit_at
  ON deals(technical_visit_at)
  WHERE technical_visit_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deals_installation_date
  ON deals(installation_date)
  WHERE installation_date IS NOT NULL;

COMMENT ON COLUMN deals.panel_count IS
  'Number of solar panels in the quoted/installed system. NULL until sized.';

COMMENT ON COLUMN deals.technical_visit_at IS
  'Scheduled site survey — date AND time, since it is a physical appointment. '
  'TIMESTAMPTZ so it renders correctly regardless of the viewer''s timezone.';

COMMENT ON COLUMN deals.installation_date IS
  'Scheduled install day. DATE (no time): crews are booked by day, and the '
  'team tracks CFE paperwork from this date onward before energising.';

COMMENT ON COLUMN deals.quote_url IS
  'Link to the quote sent to the customer, so an agent can pull it up mid-'
  'conversation. Free-form URL — not validated in the DB so imports and '
  'legacy links cannot fail the write; the deal form validates on entry.';
