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
  // The extension past 16 panels. Ranges are transcribed from the
  // company's own sheet rather than continued arithmetically, which is
  // why the 18-panel band is 336 kWh wide where every other band is
  // 320: the sheet's own boundary, and every band above it inherits
  // that +16 offset. See `WATTS_PER_PANEL` and the coverage test in
  // `finance.test.ts` for what that costs.
  { minKwh: 2_625, maxKwh: 2_960, panels: 18, systemKw: 11.25, priceMxn: 161_300 },
  { minKwh: 2_961, maxKwh: 3_280, panels: 20, systemKw: 12.5, priceMxn: 173_150 },
  { minKwh: 3_281, maxKwh: 3_600, panels: 22, systemKw: 13.75, priceMxn: 196_500 },
  { minKwh: 3_601, maxKwh: 3_920, panels: 24, systemKw: 15, priceMxn: 210_800 },
  { minKwh: 3_921, maxKwh: 4_240, panels: 26, systemKw: 16.25, priceMxn: 229_000 },
  { minKwh: 4_241, maxKwh: 4_560, panels: 28, systemKw: 17.5, priceMxn: 242_000 },
  { minKwh: 4_561, maxKwh: 4_880, panels: 30, systemKw: 18.75, priceMxn: 264_000 },
  { minKwh: 4_881, maxKwh: 5_200, panels: 32, systemKw: 20, priceMxn: 279_900 },
  { minKwh: 5_201, maxKwh: 5_520, panels: 34, systemKw: 21.25, priceMxn: 299_500 },
  { minKwh: 5_521, maxKwh: 5_840, panels: 36, systemKw: 22.5, priceMxn: 311_300 },
  { minKwh: 5_841, maxKwh: 6_160, panels: 38, systemKw: 23.75, priceMxn: 333_300 },
  { minKwh: 6_161, maxKwh: 6_480, panels: 40, systemKw: 25, priceMxn: 345_200 },
])

/**
 * The ceiling of a tier table — above it the system needs a bespoke
 * design, so escalate rather than guess. Takes the table as an argument
 * because the Cotizador prices against account-defined tables whose
 * ceiling is whatever the owner typed, not this module's.
 */
export function maxQuotableKwh(tiers: readonly SolarTier[]): number {
  return tiers.length > 0 ? tiers[tiers.length - 1].maxKwh : 0
}

/** Above this the system needs a bespoke design — escalate, never guess. */
export const MAX_QUOTABLE_KWH = maxQuotableKwh(SOLAR_TIERS)

/**
 * Panel wattage, derived from the table rather than configured: every
 * tier divides out to exactly 625 W, from 2500/4 at the bottom to
 * 25000/40 at the top. `pricing.test.ts` asserts that stays true, so a
 * future tier that breaks the ratio fails CI instead of silently
 * printing a wrong wattage on the proposal.
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
 * A bimester below this fraction of the window's own MEDIAN is not
 * "a mild winter" — it is the house standing empty, under construction,
 * or on a different meter.
 *
 * Both halves of that sentence were wrong before and cost a real quote.
 * The comparison used to be against the mean at 0.4, on the assumption
 * that Cancún swings about 2:1 between a winter and a summer bimester.
 * A low-baseline house swings far harder — one real bill runs
 * [1611, 1220, 683, 328, 655, 1060], a 4.9:1 spread, because the AC is
 * nearly the whole load and there is little else underneath it. Its
 * January reads as an empty house, and the previous January (312 kWh)
 * proves it is simply January.
 *
 * The median fixes the axis: summer peaks drag a mean upward and raise
 * the bar winter has to clear, while the median sits on the middle of
 * the year regardless. Against the median that same winter lands at
 * 0.38 and a genuinely vacant bimester at 0.20, so 0.30 separates them
 * with room on both sides.
 */
export const ANOMALY_FLOOR_RATIO = 0.3

/**
 * The mirror of `ANOMALY_FLOOR_RATIO`: a bimester this far ABOVE the
 * window's median is not a hot summer, it is a number that was read
 * wrong.
 *
 * The floor catches a house that was empty. This catches the failure
 * that costs the customer money instead of the company: one inflated
 * figure drags the average up a tier or two, and the customer is quoted
 * a system larger and dearer than their roof needs. `EXTRACTION_PROMPT`
 * already tells the model to suspect itself past 3x the historial max —
 * the accumulated meter reading misread as a period — but that is the
 * model policing itself. This is the same instinct enforced in code,
 * where it cannot be forgotten mid-response.
 *
 * 4.0 rather than a naive mirror of the floor (1/0.3 = 3.33), because
 * the cost of the two mistakes is not symmetric and the false-positive
 * history here is real (see the floor's note, and commit d534877). Every
 * legitimate bill on file peaks well under it: the vacancy fixture at
 * 2.32x median is the worst, the ordinary Cancún swing 1.42x, and the
 * low-baseline house that broke the old floor rule 1.85x. 4.0 leaves the
 * highest real reading 1.7x of headroom while still catching the
 * order-of-magnitude slips this exists for.
 */
export const ANOMALY_CEILING_RATIO = 4

/**
 * How far the bill's own bimester may run past the highest one in its
 * history before the history stops describing the household at all.
 *
 * The floor and the ceiling above both measure against the window's
 * median, and a house that stood empty for most of the year defeats
 * both: the empty bimesters ARE the median. One real bill ran
 * [2383, 103, 65, 36, 38, 38] — the family had just moved in. Nothing
 * sat below 30% of a 51 kWh median, the ceiling read 2383 as a misread
 * bimester, and once the customer said "así será" the proposal went out
 * sized on the 444 kWh average: 4 panels, and a promise that the bill
 * would drop to the fixed charge.
 *
 * Measured against the history's MAX rather than its median, so a hot
 * summer is not mistaken for a new household: the year behind a real
 * seasonal peak holds last summer too. 3x clears every legitimate bill
 * on file (the worst, the low-baseline house, is 1.32x its history's
 * peak) and still catches the move-in by an order of magnitude.
 */
export const OUTGROWN_HISTORY_RATIO = 3

/** Why a reading is priced but not safe to put on a PDF unattended. */
export type ReviewReason =
  /** The bill's own bimester never made it into the average. */
  | 'missing_current_period'
  /** The window mixes occupied and unoccupied periods. */
  | 'anomalous_history'
  /** One bimester towers over the rest — almost always a misread. */
  | 'anomalous_history_high'
  /**
   * The bill's own bimester towers over its history: a household that
   * just moved in, or started living in the house differently. The
   * average mixes the two and undersizes the system, and no answer the
   * customer gives makes it the right number — a person sizes this one
   * from the current consumption.
   */
  | 'current_outgrows_history'

/**
 * Signals the pricing table cannot see for itself. Optional: callers
 * that only want the tier for a number typed in chat pass nothing and
 * get the old behaviour. The two callers that put a price on a document
 * — `formatReceiptNote` and `sendQuoteProposal` — always pass it.
 */
export interface QuoteEvidence {
  /** False when the current period was unreadable and the average is
   *  built from history alone. */
  includesCurrentPeriod?: boolean
  /** The individual readings behind the average, for outlier checks. */
  periods?: readonly number[]
}

/** The middle value of a window, averaging the two middles when even. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The lowest reading in the window when it sits far enough below the
 * window's own median to mean the periods are not comparable, else
 * null. Two periods is enough to ask the question: at n=2 the median is
 * the mean, so the rule needs better than a 5.7:1 spread — which no
 * thermostat produces.
 *
 * Deliberately keyed to the single lowest value rather than to a gap
 * between the two lowest: a house left empty for two bimesters running
 * shows two near-identical lows, and a "how far is the floor from the
 * next one up" test would wave it straight through.
 */
export function findAnomalousPeriod(
  periods: readonly number[],
): number | null {
  const values = periods.filter((v) => Number.isFinite(v) && v >= 0)
  if (values.length < 2) return null
  const middle = median(values)
  if (middle <= 0) return null
  const lowest = Math.min(...values)
  return lowest < middle * ANOMALY_FLOOR_RATIO ? lowest : null
}

/**
 * The highest reading in the window when it towers far enough over the
 * window's own median to mean it was misread, else null.
 *
 * Same shape and the same n>=2 guard as `findAnomalousPeriod`, and the
 * same known dead spot at exactly two periods: the max of two positive
 * numbers is always under twice their mean, so a two-period window can
 * never trip a 4x ceiling. That is accepted rather than special-cased —
 * two periods is already `low_confidence` territory, and inventing a
 * tighter rule for the case with the least evidence behind it is how
 * false positives get made.
 */
export function findAnomalousHighPeriod(
  periods: readonly number[],
): number | null {
  const values = periods.filter((v) => Number.isFinite(v) && v >= 0)
  if (values.length < 2) return null
  const middle = median(values)
  if (middle <= 0) return null
  const highest = Math.max(...values)
  return highest > middle * ANOMALY_CEILING_RATIO ? highest : null
}

/**
 * The bill's own bimester when it has outgrown everything in its
 * history, else null. See `OUTGROWN_HISTORY_RATIO`.
 *
 * `periods` is newest first with the current bimester at index 0 —
 * callers pass it only when the reading includes one. Two past bimesters
 * at least, the same bar the outlier checks set: one is not a history.
 */
export function findOutgrownHistory(
  periods: readonly number[],
): number | null {
  const [current, ...rest] = periods
  if (current == null || !Number.isFinite(current) || current <= 0) return null
  const history = rest.filter((v) => Number.isFinite(v) && v >= 0)
  if (history.length < 2) return null
  return current > Math.max(...history) * OUTGROWN_HISTORY_RATIO
    ? current
    : null
}

/**
 * Pure table probe: the tier a consumption falls in, or null when it is
 * outside the table entirely. Total on every input — callers get null
 * for NaN, Infinity, and negatives rather than an exception.
 */
export function lookupSolarTier(
  kwh: number,
  tiers: readonly SolarTier[] = SOLAR_TIERS,
): SolarTier | null {
  if (!Number.isFinite(kwh)) return null
  // `promedio_bimestral_kwh` already arrives rounded, but this function
  // is exported and must not leave a gap between 704 and 705 for a
  // caller that passes a raw average.
  const value = Math.round(kwh)
  return tiers.find((t) => value >= t.minKwh && value <= t.maxKwh) ?? null
}

/**
 * The package for a customer who asks by panel count instead of sending
 * a bill: the smallest tier with at least that many panels, or null past
 * the table (bespoke design — a person quotes it).
 *
 * Packages step in pairs, 4 to 40, so an odd or in-between request
 * rounds UP: 13 prices the 14-panel system, never the 12, because a
 * sheet short of what the customer asked for reads as a bait price. A
 * request under the smallest package gets the smallest package.
 */
export function tierForPanels(
  panels: number,
  tiers: readonly SolarTier[] = SOLAR_TIERS,
): SolarTier | null {
  if (!Number.isFinite(panels) || panels <= 0) return null
  return tiers.find((t) => t.panels >= panels) ?? null
}

export type QuoteResolution =
  /** Quotable: state these numbers, attach the PDF. */
  | { kind: 'ok'; kwh: number; tier: SolarTier }
  /** Quotable, but from too few periods to commit to a document. */
  | { kind: 'low_confidence'; kwh: number; tier: SolarTier; periods: number }
  /**
   * Priced, but the window itself is suspect — the bot must ask the
   * customer before a document goes out. The tier still comes through
   * so the bot can talk about a ballpark if pressed.
   */
  | {
      kind: 'needs_review'
      kwh: number
      tier: SolarTier
      reason: ReviewReason
      /** The offending bimester, when the reason is an outlier. */
      outlierKwh?: number
    }
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
 *
 * `tiers` defaults to the residential table above, so the bot's calls
 * are unchanged. The Cotizador passes an account-defined table instead.
 */
export function resolveQuote(
  kwh: number | null,
  periodsUsed: number,
  evidence: QuoteEvidence = {},
  tiers: readonly SolarTier[] = SOLAR_TIERS,
): QuoteResolution {
  if (kwh == null || !Number.isFinite(kwh)) return { kind: 'unreadable' }
  if (!isPlausibleAverage(kwh)) return { kind: 'implausible', kwh }
  if (kwh > maxQuotableKwh(tiers)) return { kind: 'above_table', kwh }

  const tier = lookupSolarTier(kwh, tiers)
  // Unreachable given the guards above; treated as "don't guess" rather
  // than asserted, so a future edit that opens a gap in the table
  // degrades to a handoff instead of a crash mid-conversation.
  if (!tier) return { kind: 'above_table', kwh }

  if (periodsUsed < MIN_PERIODS_FOR_PDF) {
    return { kind: 'low_confidence', kwh, tier, periods: periodsUsed }
  }

  // Both checks below describe a window that prices cleanly and is still
  // the wrong window. They run last so "unreadable" and "past the table"
  // keep their own replies, and they only fire when the caller supplied
  // the evidence — a bare two-argument call is unchanged.
  //
  // The current bimester is the one the customer is looking at while
  // they type, and on a house that just came back into use it is the
  // only period that reflects how they actually live. Averaging without
  // it silently sizes the system for whoever was here before.
  if (evidence.includesCurrentPeriod === false) {
    return { kind: 'needs_review', kwh, tier, reason: 'missing_current_period' }
  }

  if (evidence.periods) {
    // The bill's own bimester, when the reading has one. It is the only
    // period the history can be outgrown BY, and the only high outlier
    // that is not a stray row: a customer who confirms it is how they
    // live now has just said the average is the wrong number.
    const current =
      evidence.includesCurrentPeriod === true ? evidence.periods[0] : undefined

    // First, because it answers the question the other two would ask
    // for nothing: however the customer explains a history that no
    // longer describes them, the average cannot size their system.
    if (current != null && findOutgrownHistory(evidence.periods) != null) {
      return {
        kind: 'needs_review',
        kwh,
        tier,
        reason: 'current_outgrows_history',
        outlierKwh: current,
      }
    }

    const outlier = findAnomalousPeriod(evidence.periods)
    if (outlier != null) {
      return {
        kind: 'needs_review',
        kwh,
        tier,
        reason: 'anomalous_history',
        outlierKwh: outlier,
      }
    }
    // After the floor, deliberately. A window can trip both, and the
    // empty-house question is the one a person can actually answer —
    // "was the house occupied?" has a yes or no, where "is this figure
    // real?" sends them back to the paper bill either way.
    const high = findAnomalousHighPeriod(evidence.periods)
    if (high != null) {
      return {
        kind: 'needs_review',
        kwh,
        tier,
        // The ceiling was written for a stray row read wrong. When the
        // bimester towering over the rest is the bill's own, the "yes,
        // that's real" it is waiting for means the customer lives at that
        // level now — which the average undersizes, however it is asked.
        reason: high === current ? 'current_outgrows_history' : 'anomalous_history_high',
        outlierKwh: high,
      }
    }
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
