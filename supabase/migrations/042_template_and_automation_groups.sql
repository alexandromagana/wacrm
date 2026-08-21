-- ============================================================
-- 042_template_and_automation_groups.sql
--
-- Filing for message_templates and automations.
--
-- Meta freezes a template's `name` at approval, so the name can never
-- become the filing: `seguimiento_coti`, `sin_respuesta` and
-- `gama_seguimiento_lead` are three stages of the same follow-up and
-- sort nowhere near each other in an alphabetical list. Same problem on
-- the automations list, where five of the twelve rows are button
-- handlers that only make sense read together.
--
-- `template_group` is a plain nullable TEXT — no CHECK constraint. The
-- vocabulary lives in src/lib/template-groups.ts, which renders an
-- unrecognised value as its own group rather than dropping the row, so
-- inventing a group here (or straight from the Supabase table editor)
-- never costs a migration. NULL files under "Sin categoría".
--
-- The UPDATEs below seed the nine templates and twelve automations that
-- exist today. They are matched by name and scoped with
-- `template_group IS NULL`, so re-running never overwrites a filing
-- changed later from the UI.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS template_group TEXT;

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS template_group TEXT;

-- Both lists are short and always rendered whole (no pagination), so
-- these exist for ordering, not for lookup selectivity.
CREATE INDEX IF NOT EXISTS idx_message_templates_group
  ON message_templates(template_group);
CREATE INDEX IF NOT EXISTS idx_automations_group
  ON automations(template_group);

-- ------------------------------------------------------------
-- Seed: templates
-- ------------------------------------------------------------

-- Nudges after a quote or a fresh lead. `seguimiento_cotizacion` is
-- PENDING_DELETION but still files here — it stays visible in the
-- manager until Meta finishes removing it.
UPDATE message_templates SET template_group = 'Seguimiento'
  WHERE template_group IS NULL
    AND name IN ('gama_seguimiento_lead', 'seguimiento_coti', 'seguimiento_cotizacion');

UPDATE message_templates SET template_group = 'Sin respuesta'
  WHERE template_group IS NULL
    AND name = 'sin_respuesta';

-- Pre- and post-visit kept as one group: three templates spread over
-- two headers is more scrolling than filing.
UPDATE message_templates SET template_group = 'Visitas'
  WHERE template_group IS NULL
    AND name IN ('visita_confirmacion', 'visita_recordatorio', 'post_visita');

UPDATE message_templates SET template_group = 'Recibo'
  WHERE template_group IS NULL
    AND name = 'recordatorio_recibo';

-- Meta's stock sample. Never sent to a customer, but it can't be
-- deleted either, so it gets a group that says so.
UPDATE message_templates SET template_group = 'Sistema'
  WHERE template_group IS NULL
    AND name = 'hello_world';

-- ------------------------------------------------------------
-- Seed: automations
-- ------------------------------------------------------------

UPDATE automations SET template_group = 'Leads nuevos'
  WHERE template_group IS NULL
    AND name IN (
      'New lead → pipeline',
      'FB Pendiente WA → pedir recibo',
      'FB Pendiente WA → quitar al responder'
    );

-- The two nudges plus the tag bookkeeping that cancels them. Filed
-- together because reading the cancel rule is the only way to see why
-- the nudges stop.
UPDATE automations SET template_group = 'Seguimiento de cotización'
  WHERE template_group IS NULL
    AND name IN (
      'Quote follow-up — 48h no reply',
      'Quote follow-up — 5 días sin respuesta',
      'Clear follow-up tag on reply'
    );

UPDATE automations SET template_group = 'Respuestas de botón'
  WHERE template_group IS NULL
    AND trigger_type = 'interactive_reply';

UPDATE automations SET template_group = 'Pipeline'
  WHERE template_group IS NULL
    AND name = 'Quote sent → Proposal Sent';
