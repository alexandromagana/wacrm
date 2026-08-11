// ============================================================
// Solar pre-quote pricing.
//
// This table previously existed only as prose inside the account's
// `ai_configs.system_prompt`, where the model read it and did the
// kWh → panels → price mapping itself, in text. That is tolerable in a
// chat — a wrong number gets corrected in the next message — but not on
// a branded PDF with the company logo on it. Here the mapping is
// deterministic, and the resolved tier is fed BACK to the model (see
// `formatReceiptNote`) so the prose and the document can never disagree.
//
// Trade-off worth knowing: prices now change by deploy rather than by
// editing a text box in Settings.
// ============================================================

export interface SolarTier {
  /** Inclusive lower bound of the bimonthly average, kWh. */
  minKwh: number
  /** Inclusive upper bound. */
  maxKwh: number
  panels: number
  /** System size, kW peak. */
  systemKw: number
  /** Turnkey price in MXN, IVA included, whole pesos. */
  priceMxn: number
}

export const SOLAR_TIERS: readonly SolarTier[] = Object.freeze([
  { minKwh: 0, maxKwh: 704, panels: 4, systemKw: 2.5, priceMxn: 43_200 },
  { minKwh: 705, maxKwh: 1_024, panels: 6, systemKw: 3.75, priceMxn: 62_400 },
  { minKwh: 1_025, maxKwh: 1_344, panels: 8, systemKw: 5, priceMxn: 75_500 },
  { minKwh: 1_345, maxKwh: 1_664, panels: 10, systemKw: 6.25, priceMxn: 95_000 },
  { minKwh: 1_665, maxKwh: 1_984, panels: 12, systemKw: 7.5, priceMxn: 106_900 },
  { minKwh: 1_985, maxKwh: 2_304, panels: 14, systemKw: 8.75, priceMxn: 127_000 },
  { minKwh: 2_305, maxKwh: 2_624, panels: 16, systemKw: 10, priceMxn: 140_000 },
])

/** Above this the system needs a bespoke design — escalate, never guess. */
export const MAX_QUOTABLE_KWH = SOLAR_TIERS[SOLAR_TIERS.length - 1].maxKwh

/**
 * Panel wattage, derived from the table rather than configured: every
 * tier divides out to exactly 625 W (2500/4, 3750/6, 5000/8, 6250/10,
 * 7500/12, 8750/14, 10000/16). `pricing.test.ts` asserts that stays
 * true, so a future tier that breaks the ratio fails CI instead of
 * silently printing a wrong wattage on the proposal.
 */
export const WATTS_PER_PANEL = 625

/**
 * At least this many billing periods before we'll put a price on a PDF.
 * A "bimonthly average" taken from one period is not an average — and in
 * Cancún the air-conditioning swing between a summer and a winter
 * bimester can straddle two or three tiers.
 */
export const MIN_PERIODS_FOR_PDF = 2

/**
 * Sanity bounds: a residential/commercial bimonthly average outside
 * this range is far more likely a misread than a real bill. Lives here
 * rather than with the vision extraction because it decides what we're
 * willing to attach a price to; `src/lib/ai/receipt` re-exports it for
 * its existing callers.
 */
export function isPlausibleAverage(kwh: number): boolean {
  return kwh >= 50 && kwh <= 20_000
}

/**
 * Pure table probe: the tier a consumption falls in, or null when it is
 * outside the table entirely. Total on every input — callers get null
 * for NaN, Infinity, and negatives rather than an exception.
 */
export function lookupSolarTier(kwh: number): SolarTier | null {
  if (!Number.isFinite(kwh)) return null
  // `promedio_bimestral_kwh` already arrives rounded, but this function
  // is exported and must not leave a gap between 704 and 705 for a
  // caller that passes a raw average.
  const value = Math.round(kwh)
  return SOLAR_TIERS.find((t) => value >= t.minKwh && value <= t.maxKwh) ?? null
}

export type QuoteResolution =
  /** Quotable: state these numbers, attach the PDF. */
  | { kind: 'ok'; kwh: number; tier: SolarTier }
  /** Quotable, but from too few periods to commit to a document. */
  | { kind: 'low_confidence'; kwh: number; tier: SolarTier; periods: number }
  /** Past the table — bespoke design, hand off to a human. */
  | { kind: 'above_table'; kwh: number }
  /** A number, but not one a real bill would show. */
  | { kind: 'implausible'; kwh: number }
  /** No usable reading at all. */
  | { kind: 'unreadable' }

/**
 * Decide what the bot may say and send for a given receipt reading.
 *
 * Order matters: an implausible value is reported as such even when it
 * also happens to exceed the table, because "that reading looks wrong"
 * and "your project is too big for a standard package" call for
 * completely different replies.
 */
export function resolveQuote(
  kwh: number | null,
  periodsUsed: number,
): QuoteResolution {
  if (kwh == null || !Number.isFinite(kwh)) return { kind: 'unreadable' }
  if (!isPlausibleAverage(kwh)) return { kind: 'implausible', kwh }
  if (kwh > MAX_QUOTABLE_KWH) return { kind: 'above_table', kwh }

  const tier = lookupSolarTier(kwh)
  // Unreachable given the guards above; treated as "don't guess" rather
  // than asserted, so a future edit that opens a gap in the table
  // degrades to a handoff instead of a crash mid-conversation.
  if (!tier) return { kind: 'above_table', kwh }

  if (periodsUsed < MIN_PERIODS_FOR_PDF) {
    return { kind: 'low_confidence', kwh, tier, periods: periodsUsed }
  }
  return { kind: 'ok', kwh, tier }
}

/**
 * The table as prose, for pasting into the Settings system prompt. The
 * model still needs it to answer "¿cuánto por 1,500 kWh?" asked in plain
 * text with no receipt attached; when a receipt IS present, the resolved
 * tier is injected per-turn and overrides whatever the prompt says.
 */
export function renderPricingTableForPrompt(): string {
  const rows = SOLAR_TIERS.map((t) => {
    const range = `${t.minKwh.toLocaleString('es-MX')} - ${t.maxKwh.toLocaleString('es-MX')}`
    const price = `$${t.priceMxn.toLocaleString('es-MX')}`
    return `| ${range} | ${t.panels} | ${t.systemKw} kW | ${price} |`
  })
  return [
    '| Consumo bimestral (kWh) | Paneles | Sistema aprox. | Precio estimado |',
    '|---|---|---|---|',
    ...rows,
    `| ${(MAX_QUOTABLE_KWH + 1).toLocaleString('es-MX')} en adelante | — | — | Escala a Alejandro |`,
  ].join('\n')
}
