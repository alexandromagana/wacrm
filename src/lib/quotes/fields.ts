import type { SolarTier } from './pricing'
import { WATTS_PER_PANEL } from './pricing'
import type { Financials } from './finance'

// ============================================================
// The exact strings drawn onto the proposal template.
//
// Pure and deterministic given `now`, so the interesting half of PDF
// generation is unit-testable without pdf-lib, a template file, or a
// golden-image fixture (this repo has no snapshot pattern).
//
// Formats mirror the placeholders in the Figma design so replacements
// sit exactly where the originals did: "$ ---" → "$ 95,000",
// "--- kWp" → "6.25 kWp", "00 / 00 / 2026" → "11 / 08 / 2026".
// ============================================================

const DEFAULT_TIMEZONE = 'America/Cancun'

/**
 * Validity window, mirroring the static copy already printed on the
 * cover and on page 2. Only repeated here because page 3 states it on
 * the same line as the folio, which forces us to redraw the whole line.
 */
const VIGENCIA = '15 DÍAS NATURALES'

/**
 * The static second line of the payback paragraph. Redrawn by us only
 * because it shares a text layer with the first line, which carries two
 * variables mid-sentence — hiding one hides both.
 */
const PAYBACK_NOTA = 'de ahí, todo lo que produce tu techo es ganancia.'

export type FieldKey =
  | 'nombre'
  | 'folioPortada'
  | 'folio'
  | 'fecha'
  | 'paneles'
  | 'wattsPorPanel'
  | 'kwp'
  | 'precio'
  | 'precotizacion'
  // Page A1's comparison cards, savings and payback.
  | 'gastoSinBimestre'
  | 'gastoSin12Meses'
  | 'gastoSin25Anios'
  | 'gastoConBimestre'
  | 'gastoCon12Meses'
  | 'gastoCon25Anios'
  | 'ahorro25Anios'
  | 'payback'
  | 'paybackNota'
  | 'kwhGenerados'

export interface QuoteInput {
  /** From `contacts.name`, which is nullable. */
  nombre: string | null
  tier: SolarTier
  /** Stable per contact, so a re-send carries the same folio. */
  folio: string
  now: Date
  /**
   * The savings projection, or null when the bill was unreadable. Null
   * blanks all ten financial fields — a proposal missing a card reads
   * as incomplete, which it is; one with an invented card does not.
   */
  financials: Financials | null
}

/**
 * Group separators and nothing else. `Intl` with a hardcoded `es-MX` —
 * NOT `src/lib/currency.ts:formatCurrency`, which resolves against the
 * server's default locale (en-US in the container) and defaults to USD.
 */
export function formatKwh(value: number): string {
  return new Intl.NumberFormat('es-MX').format(Math.round(value))
}

/**
 * "$ 95,000" — the space after the sign is deliberate, matching the
 * design's own "$ ---" placeholder. Whole pesos: centavos on a
 * pre-quote imply a precision the visit hasn't confirmed yet.
 */
export function formatMxn(value: number): string {
  return `$ ${new Intl.NumberFormat('es-MX').format(Math.round(value))}`
}

/** "6.25 kWp". Trailing zeros trimmed — 5 kW reads "5", not "5.00". */
export function formatKwp(systemKw: number): string {
  return `${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 }).format(systemKw)} kWp`
}

/** "11 / 08 / 2026", spaced like the design's "00 / 00 / 2026". */
export function formatQuoteDate(now: Date): string {
  const timeZone = process.env.AI_TIMEZONE || DEFAULT_TIMEZONE
  const parts = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('day')} / ${get('month')} / ${get('year')}`
}

/**
 * "GE-2026-4F7A". Deterministic in `seed`, so re-sending the same
 * proposal to the same customer reproduces the folio they already wrote
 * down — the whole point of quoting one over the phone.
 *
 * Callers seed with the contact id AND the quoted system, never the
 * contact alone: two documents that differ on price and panel count must
 * not share a "unique" folio, or the number sales reads back over the
 * phone no longer identifies which of them the customer is holding.
 * FNV-1a: not a security hash, just a stable spread.
 */
export function buildFolio(now: Date, seed: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const suffix = h.toString(36).toUpperCase().slice(-4).padStart(4, '0')
  const timeZone = process.env.AI_TIMEZONE || DEFAULT_TIMEZONE
  const year = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    year: 'numeric',
  }).format(now)
  return `GE-${year}-${suffix}`
}

/**
 * "2 años 1 mes" — singular and plural both, and no zero terms: the
 * design's placeholder reads "— años — meses", but "3 años 0 meses" on
 * a document meant to sound confident does not.
 */
export function formatPaybackDuration(anios: number, meses: number): string {
  const parts: string[] = []
  if (anios > 0) parts.push(`${anios} ${anios === 1 ? 'año' : 'años'}`)
  if (meses > 0) parts.push(`${meses} ${meses === 1 ? 'mes' : 'meses'}`)
  return parts.length > 0 ? parts.join(' ') : 'menos de un mes'
}

/**
 * Make a string safe to draw with an embedded TTF.
 *
 * A glyph the font lacks renders as .notdef — a blank or a hollow box —
 * with no error raised, so a bad character ships to the customer
 * looking like a broken document. And if a field ever falls back to a
 * StandardFont, pdf-lib throws outright on anything past WinAnsi.
 *
 * Accents, ñ, ¿ and ¡ all pass through untouched; they exist in every
 * real TTF and in Latin-1.
 */
export function sanitizeForPdf(value: string): string {
  return value
    // NFC first: WhatsApp profile names and the vision model's `ciudad`
    // can both arrive decomposed, where "é" is e + a combining accent
    // and the accent alone has no glyph of its own.
    .normalize('NFC')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    // Narrow and non-breaking spaces: Intl emits these in some
    // locale/ICU combinations, and they are commonly missing from
    // display fonts.
    .replace(/[    ]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Every drawable string for one proposal. Values are pre-sanitised, so
 * the renderer draws them verbatim.
 */
export function buildQuoteFieldValues(
  input: QuoteInput,
): Record<FieldKey, string> {
  const { nombre, tier, folio, now, financials: f } = input
  // An empty string, never the literal "null" — the label above it
  // ("PREPARADA PARA") still reads fine with the value blank.
  const name = nombre ? sanitizeForPdf(nombre) : ''
  return {
    nombre: name,
    folioPortada: folio,
    folio,
    fecha: formatQuoteDate(now),
    paneles: String(tier.panels),
    wattsPorPanel: `${WATTS_PER_PANEL} W`,
    kwp: formatKwp(tier.systemKw),
    precio: formatMxn(tier.priceMxn),
    // Page 3's header runs the folio through the middle of a sentence,
    // so the line is redrawn whole rather than patched. Spacing around
    // the middle dot matches the design exactly.
    precotizacion: `PRECOTIZACIÓN ${folio}  ·  VIGENCIA ${VIGENCIA}`,

    // All ten stand or fall together: half a comparison table is worse
    // than none, and the reader cannot tell which half is missing.
    gastoSinBimestre: f ? formatMxn(f.sinPanelesBimestre) : '',
    gastoSin12Meses: f ? formatMxn(f.sinPaneles12Meses) : '',
    gastoSin25Anios: f ? formatMxn(f.sinPaneles25Anios) : '',
    gastoConBimestre: f ? formatMxn(f.conPanelesBimestre) : '',
    gastoCon12Meses: f ? formatMxn(f.conPaneles12Meses) : '',
    gastoCon25Anios: f ? formatMxn(f.conPaneles25Anios) : '',
    ahorro25Anios: f ? formatMxn(f.ahorro25Anios) : '',
    // Ends mid-sentence because the design wraps here; the rest is
    // `paybackNota`, on its own baseline 16 pt below.
    payback: f
      ? `El sistema se paga solo en ${formatPaybackDuration(f.paybackAnios, f.paybackMeses)}. A partir`
      : '',
    paybackNota: f ? PAYBACK_NOTA : '',
    kwhGenerados: f ? `${formatKwh(f.kwhGeneradosBimestre)} kWh` : '',
  }
}
