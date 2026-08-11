import type { SolarTier } from './pricing'
import { WATTS_PER_PANEL } from './pricing'

// ============================================================
// The savings projection printed on page A1.
//
// Pure and deterministic, like `pricing.ts`, and for the same reason:
// these numbers go on a branded PDF with a folio on it. A model doing
// this arithmetic in prose gets it subtly wrong; the difference between
// a compounded sum and a multiplication here is six figures.
// ============================================================

/**
 * Assumed annual rise in the cost of CFE electricity, compounded. A
 * projection with no inflation understates the customer's real spend by
 * roughly a third over 25 years, so the assumption has to be explicit —
 * and it is stated on the proposal itself.
 */
export const ANNUAL_INFLATION = 0.035

/**
 * What the customer still pays CFE once the system covers their
 * consumption: the minimum charge, and nothing else. Systems are sized
 * against 100% of the bimonthly average precisely so the bill lands
 * here.
 *
 * Bimonthly, matching the card it is printed on ("Al bimestre"). If
 * this ever needs to be a monthly figure it is one constant, and the
 * effect is negligible against a five-figure bill.
 */
export const FIXED_CHARGE_BIMONTHLY_MXN = 65

export const BIMESTERS_PER_YEAR = 6
export const HORIZON_YEARS = 25

/** Peak sun hours per day assumed for the Riviera Maya. */
export const PEAK_SUN_HOURS = 5
/** Derating for inverter, wiring, soiling and temperature losses. */
export const SYSTEM_EFFICIENCY = 0.85
export const DAYS_PER_BIMESTER = 60

/**
 * Which reading of the receipt the money projection is based on.
 *
 * `periodo_actual` uses the bill the customer just sent. It reflects
 * today's prices but inherits whatever season that bill fell in — in
 * Cancún a summer bimester can run well above the annual average, and
 * the projection inherits that. `promedio_6` averages the same six
 * periods the kWh average already uses, which is internally consistent
 * with how the system is SIZED but mixes in year-old prices.
 *
 * Set to `periodo_actual` by the business owner's explicit choice.
 */
export type ProjectionBase = 'periodo_actual' | 'promedio_6'
export const PROJECTION_BASE: ProjectionBase = 'periodo_actual'

/**
 * Sum of a series growing at `inflation` for `years` years, relative to
 * the first year: ((1 + i)^n − 1) / i. 38.9499 at 25 years and 3.5%.
 *
 * This is the whole point of the module. Multiplying the first year by
 * 25 instead understates a $61,424 annual spend by $856,853 — on the
 * largest number in the document.
 */
export function cumulativeFactor(years: number, inflation: number): number {
  if (!Number.isFinite(years) || years <= 0) return 0
  // i = 0 is not a special case worth a branch anywhere else, but the
  // closed form divides by it.
  if (inflation === 0) return years
  return (Math.pow(1 + inflation, years) - 1) / inflation
}

/**
 * kWh a system of `panels` produces in one bimester.
 * 625 W × 5 h × 0.85 ÷ 1000 × 60 d = 159.375 kWh per panel.
 *
 * `pricing.test.ts` checks this against the price table: generation
 * covers 90.6%–97.2% of each tier's ceiling, rising monotonically, so
 * the table and this formula were built on the same assumption.
 */
export function bimonthlyGenerationKwh(panels: number): number {
  return (
    ((WATTS_PER_PANEL * PEAK_SUN_HOURS * SYSTEM_EFFICIENCY) / 1000) *
    DAYS_PER_BIMESTER *
    panels
  )
}

/**
 * The bimonthly cost the projection is built on, per `PROJECTION_BASE`.
 *
 * Takes loose numbers rather than a `ReceiptExtraction` so this module
 * stays free of the AI/Meta layer — same reason `pricing.ts` does.
 * `historial` is the history table's importe column, which may carry
 * nulls where a row was unreadable; those are skipped, and the current
 * period is averaged in alongside them exactly as the kWh average does.
 */
export function projectionBaseCost(args: {
  costoPeriodoMxn: number | null
  historialImporteMxn?: readonly (number | null)[]
}): number | null {
  const { costoPeriodoMxn } = args
  if (costoPeriodoMxn == null || !Number.isFinite(costoPeriodoMxn)) return null
  if (PROJECTION_BASE === 'periodo_actual') return costoPeriodoMxn

  const values = [costoPeriodoMxn, ...(args.historialImporteMxn ?? [])].filter(
    (v): v is number => v != null && Number.isFinite(v),
  )
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

export interface Financials {
  /** Six card amounts, MXN. */
  sinPanelesBimestre: number
  sinPaneles12Meses: number
  sinPaneles25Anios: number
  conPanelesBimestre: number
  conPaneles12Meses: number
  conPaneles25Anios: number
  ahorro25Anios: number
  /** Whole years and remaining months, already normalised. */
  paybackAnios: number
  paybackMeses: number
  kwhGeneradosBimestre: number
}

/**
 * Years and months until cumulative savings cover the system price.
 *
 * Accumulated year by year with the saving itself growing at inflation
 * — not price ÷ first-year saving, which ignores that the thing being
 * avoided gets more expensive every year.
 *
 * Returns null when the system never pays for itself inside the
 * horizon, which also covers the degenerate case of a bill at or below
 * the fixed charge. A proposal that cannot state a payback should leave
 * the line blank rather than print a number nobody believes.
 */
function computePayback(
  priceMxn: number,
  firstYearSavingMxn: number,
): { anios: number; meses: number } | null {
  if (firstYearSavingMxn <= 0) return null

  let accumulated = 0
  let yearly = firstYearSavingMxn
  for (let years = 0; years < HORIZON_YEARS; years++) {
    if (accumulated + yearly >= priceMxn) {
      const months = Math.round(((priceMxn - accumulated) / yearly) * 12)
      // A remainder that rounds up to a full year is reported as the
      // next year with no months, never as "3 años 12 meses".
      return months >= 12
        ? { anios: years + 1, meses: 0 }
        : { anios: years, meses: months }
    }
    accumulated += yearly
    yearly *= 1 + ANNUAL_INFLATION
  }
  return null
}

/**
 * The full projection for one quote, or null when it cannot be stated
 * honestly — no readable bill, or a bill so small the system never pays
 * for itself. Callers draw blank fields rather than invented ones.
 */
export function buildFinancials(args: {
  /** What the customer pays CFE per bimester today, MXN. */
  costoBimestralMxn: number | null
  tier: SolarTier
}): Financials | null {
  const { costoBimestralMxn, tier } = args
  if (costoBimestralMxn == null || !Number.isFinite(costoBimestralMxn)) {
    return null
  }
  if (costoBimestralMxn <= FIXED_CHARGE_BIMONTHLY_MXN) return null

  const factor = cumulativeFactor(HORIZON_YEARS, ANNUAL_INFLATION)

  const sinPanelesBimestre = costoBimestralMxn
  const sinPaneles12Meses = sinPanelesBimestre * BIMESTERS_PER_YEAR
  const sinPaneles25Anios = sinPaneles12Meses * factor

  const conPanelesBimestre = FIXED_CHARGE_BIMONTHLY_MXN
  const conPaneles12Meses = conPanelesBimestre * BIMESTERS_PER_YEAR
  // The system is bought once; only the residual CFE charge inflates.
  const conPaneles25Anios = tier.priceMxn + conPaneles12Meses * factor

  const payback = computePayback(
    tier.priceMxn,
    sinPaneles12Meses - conPaneles12Meses,
  )
  if (!payback) return null

  return {
    sinPanelesBimestre,
    sinPaneles12Meses,
    sinPaneles25Anios,
    conPanelesBimestre,
    conPaneles12Meses,
    conPaneles25Anios,
    ahorro25Anios: sinPaneles25Anios - conPaneles25Anios,
    paybackAnios: payback.anios,
    paybackMeses: payback.meses,
    kwhGeneradosBimestre: bimonthlyGenerationKwh(tier.panels),
  }
}
