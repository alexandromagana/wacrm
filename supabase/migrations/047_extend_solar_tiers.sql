-- ============================================================
-- Extend the seeded price ladder from 16 panels to 40.
--
-- 041 seeded every account's "Residencial" type with the seven tiers
-- that were `SOLAR_TIERS` at the time, topping out at 2,624 kWh / 16
-- panels. The company's sheet now runs to 6,480 kWh / 40 panels, and
-- `src/lib/quotes/pricing.ts` carries the full ladder — so a Cotizador
-- priced off the DB would escalate to a human exactly where the bot now
-- quotes, which is the disagreement 041 existed to prevent.
--
-- Two things in these ranges are the sheet's and not a transcription
-- slip, and are deliberately preserved rather than smoothed:
--   * 2,625–2,960 (18 panels) is 336 kWh wide where every other band is
--     320. Every band above it inherits that +16 offset.
--   * The sheet prints 20 panels as starting at "2000", which would
--     overlap the 12-, 14- and 16-panel bands and make them
--     unreachable — `lookupSolarTier` takes the FIRST match. Read as
--     2,961, the only value that leaves the ladder contiguous.
--
-- Scoped, not blanket: only ladders that still END at 2,624 are
-- extended. An account that has since authored its own table in the
-- Cotizador UI keeps it untouched, and the NOT EXISTS on 2,625 makes a
-- re-run a no-op.
-- ============================================================

INSERT INTO quote_rate_tiers (project_type_id, min_kwh, max_kwh, panels, system_kw, price_mxn)
SELECT pt.id, v.min_kwh, v.max_kwh, v.panels, v.system_kw, v.price_mxn
FROM quote_project_types pt
CROSS JOIN (VALUES
  (2625, 2960, 18, 11.25, 161300),
  (2961, 3280, 20, 12.5,  173150),
  (3281, 3600, 22, 13.75, 196500),
  (3601, 3920, 24, 15,    210800),
  (3921, 4240, 26, 16.25, 229000),
  (4241, 4560, 28, 17.5,  242000),
  (4561, 4880, 30, 18.75, 264000),
  (4881, 5200, 32, 20,    279900),
  (5201, 5520, 34, 21.25, 299500),
  (5521, 5840, 36, 22.5,  311300),
  (5841, 6160, 38, 23.75, 333300),
  (6161, 6480, 40, 25,    345200)
) AS v(min_kwh, max_kwh, panels, system_kw, price_mxn)
WHERE EXISTS (
    SELECT 1 FROM quote_rate_tiers t
    WHERE t.project_type_id = pt.id
    GROUP BY t.project_type_id
    HAVING MAX(t.max_kwh) = 2624
  )
  AND NOT EXISTS (
    SELECT 1 FROM quote_rate_tiers t
    WHERE t.project_type_id = pt.id AND t.min_kwh = 2625
  );
