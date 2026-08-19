-- ============================================================
-- 041_quote_generator.sql
--
-- The Cotizador: project types, rate tiers, document templates, and a
-- record of every quote generated.
--
-- Today's quoting engine is residential-only and deploy-only: the seven
-- price tiers live as a frozen array in src/lib/quotes/pricing.ts, and
-- the financial assumptions (inflation, peak sun hours, the CFE minimum
-- charge) are constants in src/lib/quotes/finance.ts. Changing a price
-- means shipping code. Anything the table can't price — a commercial
-- PDBT bill, an industrial GDMTH one, or a house above 2,624 kWh — has
-- to be quoted by hand in PowerPoint.
--
-- These tables move that pricing knowledge into the account's own data,
-- so a project type can be created and priced from the UI. The bot's
-- path is untouched and reads none of this: resolveQuote() and
-- buildFinancials() keep their hardcoded defaults when called without
-- the new optional arguments.
--
--   quote_project_types — one row per project type, carrying its own
--                         financial assumptions.
--   quote_rate_tiers    — child: the kWh → panels/system/price ladder.
--   quote_templates     — uploaded .docx/.pptx merge-tag documents.
--   quotes              — one row per generated document. This is the
--                         history that does not exist today:
--                         deals.quote_url holds a single link that each
--                         new quote overwrites.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. quote_project_types
--
-- The financial assumptions live here rather than in a table of their
-- own: they are a fixed handful of scalars, one set per project type,
-- not a repeating collection like the tiers. Defaults are the exact
-- values finance.ts uses today, so a project type created without
-- overrides prices identically to the residential engine.
--
-- BIMESTERS_PER_YEAR and DAYS_PER_BIMESTER stay in code — they are
-- calendar facts, not assumptions anyone should be able to edit.
-- ============================================================
CREATE TABLE IF NOT EXISTS quote_project_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  -- One of the three buckets inferPropertyType() (src/lib/ai/receipt.ts)
  -- already derives from a CFE tariff code. Lets the generator warn —
  -- never block — when the receipt's own tariff disagrees with the
  -- project type the user picked. NULL disables the cross-check.
  cfe_property_type_hint TEXT
    CHECK (cfe_property_type_hint IN ('Casa', 'Negocio', 'Industria')),
  annual_inflation NUMERIC(6,4) NOT NULL DEFAULT 0.035
    CHECK (annual_inflation >= 0 AND annual_inflation < 1),
  fixed_charge_bimonthly_mxn NUMERIC(10,2) NOT NULL DEFAULT 65
    CHECK (fixed_charge_bimonthly_mxn >= 0),
  peak_sun_hours NUMERIC(5,2) NOT NULL DEFAULT 5
    CHECK (peak_sun_hours > 0),
  system_efficiency NUMERIC(4,3) NOT NULL DEFAULT 0.85
    CHECK (system_efficiency > 0 AND system_efficiency <= 1),
  horizon_years SMALLINT NOT NULL DEFAULT 25
    CHECK (horizon_years > 0 AND horizon_years <= 50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_quote_project_types_account
  ON quote_project_types(account_id);

ALTER TABLE quote_project_types ENABLE ROW LEVEL SECURITY;

-- Settings-class: any member reads (the generator needs the list), but
-- only admins change prices. Mirrors pipelines / custom_fields (017).
DROP POLICY IF EXISTS quote_project_types_select ON quote_project_types;
DROP POLICY IF EXISTS quote_project_types_insert ON quote_project_types;
DROP POLICY IF EXISTS quote_project_types_update ON quote_project_types;
DROP POLICY IF EXISTS quote_project_types_delete ON quote_project_types;
CREATE POLICY quote_project_types_select ON quote_project_types FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY quote_project_types_insert ON quote_project_types FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY quote_project_types_update ON quote_project_types FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY quote_project_types_delete ON quote_project_types FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON quote_project_types;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON quote_project_types
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2. quote_rate_tiers
--
-- Same shape as SOLAR_TIERS in src/lib/quotes/pricing.ts. No `position`
-- column: unlike pipeline_stages, which a user drags into an arbitrary
-- order, a tier's order IS its min_kwh.
--
-- No watts-per-panel column either — it divides out of the tier as
-- (system_kw * 1000) / panels, which is the invariant pricing.test.ts
-- already asserts for every row of SOLAR_TIERS. A project type using a
-- different panel wattage therefore needs no schema change.
-- ============================================================
CREATE TABLE IF NOT EXISTS quote_rate_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_type_id UUID NOT NULL
    REFERENCES quote_project_types(id) ON DELETE CASCADE,
  min_kwh INTEGER NOT NULL CHECK (min_kwh >= 0),
  max_kwh INTEGER NOT NULL CHECK (max_kwh >= min_kwh),
  panels INTEGER NOT NULL CHECK (panels > 0),
  system_kw NUMERIC(6,2) NOT NULL CHECK (system_kw > 0),
  price_mxn NUMERIC(12,2) NOT NULL CHECK (price_mxn > 0)
);

CREATE INDEX IF NOT EXISTS idx_quote_rate_tiers_project_type
  ON quote_rate_tiers(project_type_id);

ALTER TABLE quote_rate_tiers ENABLE ROW LEVEL SECURITY;

-- Child table: no account_id of its own, so tenancy joins up through
-- the parent (the EXISTS shape used by pipeline_stages in 017).
DROP POLICY IF EXISTS quote_rate_tiers_select ON quote_rate_tiers;
DROP POLICY IF EXISTS quote_rate_tiers_modify ON quote_rate_tiers;
CREATE POLICY quote_rate_tiers_select ON quote_rate_tiers FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM quote_project_types pt
      WHERE pt.id = quote_rate_tiers.project_type_id
        AND is_account_member(pt.account_id)
    )
  );
CREATE POLICY quote_rate_tiers_modify ON quote_rate_tiers FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM quote_project_types pt
      WHERE pt.id = quote_rate_tiers.project_type_id
        AND is_account_member(pt.account_id, 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM quote_project_types pt
      WHERE pt.id = quote_rate_tiers.project_type_id
        AND is_account_member(pt.account_id, 'admin')
    )
  );

-- ============================================================
-- 3. quote_templates
--
-- Uploaded .docx / .pptx documents carrying {{tag}} placeholders. The
-- tag list found at upload time is cached on the row so the templates
-- list can flag a typo'd tag without re-downloading and re-parsing the
-- file on every page load.
-- ============================================================
CREATE TABLE IF NOT EXISTS quote_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('docx', 'pptx')),
  storage_path TEXT NOT NULL,
  storage_url TEXT NOT NULL,
  detected_tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_quote_templates_account
  ON quote_templates(account_id);

ALTER TABLE quote_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quote_templates_select ON quote_templates;
DROP POLICY IF EXISTS quote_templates_insert ON quote_templates;
DROP POLICY IF EXISTS quote_templates_update ON quote_templates;
DROP POLICY IF EXISTS quote_templates_delete ON quote_templates;
CREATE POLICY quote_templates_select ON quote_templates FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY quote_templates_insert ON quote_templates FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY quote_templates_update ON quote_templates FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY quote_templates_delete ON quote_templates FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON quote_templates;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON quote_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 4. quotes
--
-- One row per document the generator has produced.
--
-- The numbers are SNAPSHOTTED, not referenced: panels, system_kw,
-- price_mxn and the financials are copied in at generation time. Raising
-- a project type's prices next month must not silently rewrite what a
-- customer was quoted last month — and a quote already in a customer's
-- hands is the last thing that should move. The project_type_id and
-- tier_id FKs exist for traceability only, and go NULL rather than
-- CASCADE so deleting a project type never deletes its quote history.
--
-- Deliberately independent of deals.quote_url / deals.panel_count,
-- which the WhatsApp bot flow owns and overwrites. Two writers on those
-- columns would corrupt each other's bookkeeping.
-- ============================================================
CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  project_type_id UUID REFERENCES quote_project_types(id) ON DELETE SET NULL,
  tier_id UUID REFERENCES quote_rate_tiers(id) ON DELETE SET NULL,
  template_id UUID REFERENCES quote_templates(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  folio TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated', 'sent', 'accepted', 'rejected', 'expired')),
  -- Snapshot of what was quoted.
  consumo_kwh NUMERIC(10,2),
  panels INTEGER NOT NULL CHECK (panels > 0),
  system_kw NUMERIC(6,2) NOT NULL,
  price_mxn NUMERIC(12,2) NOT NULL,
  -- The computed Financials object (src/lib/quotes/finance.ts). Null
  -- when the bill carried no usable peso amount — the same case where
  -- the PDF leaves those cards blank rather than inventing them.
  financials JSONB,
  -- What the receipt itself said, kept for auditing a quote after the
  -- fact without re-reading the image.
  source_tarifa TEXT,
  source_ciudad TEXT,
  property_type_hint TEXT,
  receipt_storage_path TEXT,
  output_storage_path TEXT NOT NULL,
  output_mime_type TEXT NOT NULL,
  output_url TEXT NOT NULL,
  warnings TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quotes_account ON quotes(account_id);
CREATE INDEX IF NOT EXISTS idx_quotes_contact ON quotes(contact_id)
  WHERE contact_id IS NOT NULL;

ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;

-- Operational, not settings: quoting a customer is day-to-day agent
-- work, like creating a deal.
DROP POLICY IF EXISTS quotes_select ON quotes;
DROP POLICY IF EXISTS quotes_insert ON quotes;
DROP POLICY IF EXISTS quotes_update ON quotes;
DROP POLICY IF EXISTS quotes_delete ON quotes;
CREATE POLICY quotes_select ON quotes FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY quotes_insert ON quotes FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY quotes_update ON quotes FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY quotes_delete ON quotes FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- ============================================================
-- 5. quote-assets storage bucket
--
-- Holds both uploaded templates and generated output documents. Same
-- account-scoped path convention and public-read policy as chat-media
-- (023), so uploadAccountMedia() / uploadServerMedia() work against it
-- unchanged — only the bucket name differs.
--
--   quote-assets/account-<account_id>/<timestamp>-<basename>.<ext>
--
-- 25 MB rather than chat-media's 16: a designed .pptx carries embedded
-- images and fonts and runs heavier than a chat attachment.
--
-- The bucket allows any member to write; the admin-vs-agent split is
-- enforced by the quote_templates / quotes table policies above.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'quote-assets',
  'quote-assets',
  TRUE,
  26214400, -- 25 MB
  ARRAY[
    -- Templates and generated output
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    -- Uploaded receipts (CFE mails a PDF; customers photograph the paper)
    'application/pdf',
    'image/png', 'image/jpeg', 'image/webp'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Quote assets are publicly readable" ON storage.objects;
CREATE POLICY "Quote assets are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'quote-assets');

DROP POLICY IF EXISTS "Members can upload quote assets" ON storage.objects;
CREATE POLICY "Members can upload quote assets"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'quote-assets'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update quote assets" ON storage.objects;
CREATE POLICY "Members can update quote assets"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'quote-assets'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete quote assets" ON storage.objects;
CREATE POLICY "Members can delete quote assets"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'quote-assets'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- 6. Seed every account with "Residencial"
--
-- Today's SOLAR_TIERS, verbatim, so the generator is usable the moment
-- this migration lands and produces the same numbers the bot does. The
-- financial columns are left at their defaults, which are finance.ts's
-- current constants.
--
-- Guarded twice: the UNIQUE(account_id, name) above makes the parent
-- insert a no-op on re-run, and the NOT EXISTS below keeps a second run
-- from stacking a duplicate set of tiers onto an existing type.
-- ============================================================
INSERT INTO quote_project_types (account_id, name, cfe_property_type_hint)
SELECT id, 'Residencial', 'Casa' FROM accounts
ON CONFLICT (account_id, name) DO NOTHING;

INSERT INTO quote_rate_tiers (project_type_id, min_kwh, max_kwh, panels, system_kw, price_mxn)
SELECT pt.id, v.min_kwh, v.max_kwh, v.panels, v.system_kw, v.price_mxn
FROM quote_project_types pt
CROSS JOIN (VALUES
  (0,    704,   4,  2.5,  43200),
  (705,  1024,  6,  3.75, 62400),
  (1025, 1344,  8,  5,    75500),
  (1345, 1664, 10,  6.25, 95000),
  (1665, 1984, 12,  7.5,  106900),
  (1985, 2304, 14,  8.75, 127000),
  (2305, 2624, 16, 10,    140000)
) AS v(min_kwh, max_kwh, panels, system_kw, price_mxn)
WHERE pt.name = 'Residencial'
  AND NOT EXISTS (
    SELECT 1 FROM quote_rate_tiers t WHERE t.project_type_id = pt.id
  );
