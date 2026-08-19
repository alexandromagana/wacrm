import type { SolarTier } from './pricing'

// ============================================================
// The financing annex printed on page 5.
//
// Pure and deterministic, like `pricing.ts` and `finance.ts`, and for
// the same reason: these numbers go on a branded PDF with a folio on
// it, and the customer will compare them against a contract. An
// amortisation done in prose gets the compounding subtly wrong.
//
// Note this is a DIFFERENT thing from `finance.ts`, which projects what
// the customer saves against CFE over 25 years. This module prices the
// instalment plan Nuvolt lends against.
// ============================================================

/**
 * What Nuvolt adds to the turnkey price for carrying the paper. The
 * customer who pays cash pays `tier.priceMxn`; the one who finances
 * pays 20% more before a single peso of interest is calculated.
 *
 * This is a lender's margin, not a rate — it applies once, up front,
 * and every figure on the annex descends from the recharged price.
 */
export const RECARGO_FINANCIAMIENTO = 0.2

/** Down payment, as a share of the ALREADY-recharged price. */
export const PORCENTAJE_ENGANCHE = 0.1

/**
 * The five plans, exactly as printed on the annex.
 *
 * These rates are burned into the Figma artwork — the template PDF
 * draws "TASA 11.99%" as static text, and only the peso amounts are
 * filled in at render time. So this table and the artwork have to agree
 * or the document contradicts itself: a mensualidad computed at 13.99%
 * sitting under a printed "12.99%".
 *
 * `financing.test.ts` pins the rates for that reason. If Nuvolt moves
 * them, BOTH this table and the Figma frame have to change, and
 * `scripts/build-quote-template.mjs` has to be re-run.
 */
export const PLANES: readonly { meses: number; tasaAnual: number }[] =
  Object.freeze([
    { meses: 12, tasaAnual: 0.1199 },
    { meses: 24, tasaAnual: 0.1299 },
    { meses: 36, tasaAnual: 0.1399 },
    { meses: 48, tasaAnual: 0.1499 },
    { meses: 60, tasaAnual: 0.1599 },
  ])

/** The plan lengths, in the left-to-right order the annex prints them. */
export const PLAZOS = Object.freeze(PLANES.map((p) => p.meses))

export interface FinancingPlan {
  meses: number
  tasaAnual: number
  /** Fixed monthly payment, MXN, rounded to centavos. */
  mensualidad: number
}

export interface Financing {
  /** The cash price — `tier.priceMxn`, untouched. */
  precioBaseMxn: number
  /** After the 20% financing surcharge. */
  precioFinanciadoMxn: number
  /** 10% of the recharged price, paid up front. */
  engancheMxn: number
  /** The remaining 90%, which the instalments amortise. */
  montoAFinanciarMxn: number
  esquema: readonly FinancingPlan[]
}

/**
 * French amortisation: the payment that retires `principal` in exactly
 * `meses` equal instalments at `tasaAnual` nominal, compounded monthly.
 *
 *   P · i(1+i)^n / ((1+i)^n − 1),  i = tasaAnual / 12
 *
 * The nominal-over-12 convention is the lender's, not a simplification
 * of ours: it is what Nuvolt quotes and what the contract says, so an
 * effective-rate conversion here would make our number disagree with
 * theirs by a few pesos a month — on a document whose whole job is to
 * be checkable.
 */
export function pagoMensual(
  principal: number,
  tasaAnual: number,
  meses: number,
): number {
  if (!(meses > 0)) return 0
  const i = tasaAnual / 12
  // A zero-interest plan is not on the table today, but the closed form
  // divides by ((1+0)^n − 1) = 0, so it cannot be left to chance.
  if (i === 0) return principal / meses
  const factor = Math.pow(1 + i, meses)
  return (principal * (i * factor)) / (factor - 1)
}

/** Centavos. Every amount on the annex prints two decimals. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * The whole annex for one quoted system, or null when the price cannot
 * be financed. Callers draw blank fields rather than invented ones —
 * same contract as `buildFinancials`.
 *
 * Takes a price rather than a `SolarTier` so the Cotizador can price an
 * account-defined project type through the same rule; `fromTier` is the
 * convenience wrapper for the bot's fixed table.
 */
export function buildFinancing(
  precioBaseMxn: number,
  planes: readonly { meses: number; tasaAnual: number }[] = PLANES,
): Financing | null {
  if (!Number.isFinite(precioBaseMxn) || precioBaseMxn <= 0) return null

  const precioFinanciadoMxn = precioBaseMxn * (1 + RECARGO_FINANCIAMIENTO)
  const engancheMxn = precioFinanciadoMxn * PORCENTAJE_ENGANCHE
  const montoAFinanciarMxn = precioFinanciadoMxn - engancheMxn

  return {
    precioBaseMxn: round2(precioBaseMxn),
    precioFinanciadoMxn: round2(precioFinanciadoMxn),
    engancheMxn: round2(engancheMxn),
    montoAFinanciarMxn: round2(montoAFinanciarMxn),
    // Rounded here, once, so the string the PDF draws and any number a
    // salesperson reads off the same object cannot disagree.
    esquema: planes.map(({ meses, tasaAnual }) => ({
      meses,
      tasaAnual,
      mensualidad: round2(pagoMensual(montoAFinanciarMxn, tasaAnual, meses)),
    })),
  }
}

/** `buildFinancing` for a tier from the bot's fixed price table. */
export function financingForTier(tier: SolarTier): Financing | null {
  return buildFinancing(tier.priceMxn)
}
