import type { QuoteInput } from './fields'
import { buildQuoteFieldValues, formatKwh, sanitizeForPdf } from './fields'

// ============================================================
// Merge-tag values for a template-driven proposal.
//
// The Cotizador fills {{placeholders}} in an uploaded .docx/.pptx
// rather than drawing text at fixed coordinates. The values are the
// same either way, so this composes over `buildQuoteFieldValues`
// instead of restating twenty format calls — a peso formatted one way
// on the bot's PDF and another way on a manual one is exactly the kind
// of drift a customer notices when they hold both.
//
// The tag names are therefore the FieldKey names, unchanged. That is
// not incidental: the proposal template the business already fills by
// hand uses {{nombre}}, {{folio}}, {{gastoSinBimestre}} and the rest,
// so it can be uploaded and used as-is.
// ============================================================

export interface QuoteMergeInput extends QuoteInput {
  /** The project type this was priced against, e.g. "Comercial PDBT". */
  tipoProyecto: string
  /** Read off the receipt, when the vision pass found it. */
  ciudad?: string | null
  /** The bimonthly average the tier was chosen from. */
  consumoKwh?: number | null
}

/**
 * Every tag a quote template may reference: the nineteen the fixed-
 * position PDF already draws, plus three the generator knows and it
 * does not (the bot has exactly one project type, and prints neither
 * the city nor the raw consumption).
 */
export const QUOTE_MERGE_TAGS = [
  'nombre',
  'folioPortada',
  'folio',
  'fecha',
  'paneles',
  'wattsPorPanel',
  'kwp',
  'precio',
  'precotizacion',
  'gastoSinBimestre',
  'gastoSin12Meses',
  'gastoSin25Anios',
  'gastoConBimestre',
  'gastoCon12Meses',
  'gastoCon25Anios',
  'ahorro25Anios',
  'payback',
  'paybackNota',
  'kwhGenerados',
  'tipoProyecto',
  'ciudad',
  'consumoKwh',
] as const

export type QuoteMergeTag = (typeof QUOTE_MERGE_TAGS)[number]

/**
 * The value for every merge tag, pre-sanitised. Tags the quote can't
 * fill come back as empty strings rather than missing keys, so a
 * template referencing one renders blank instead of failing.
 */
export function buildQuoteMergeFields(
  input: QuoteMergeInput,
): Record<QuoteMergeTag, string> {
  return {
    ...buildQuoteFieldValues(input),
    tipoProyecto: sanitizeForPdf(input.tipoProyecto),
    ciudad: input.ciudad ? sanitizeForPdf(input.ciudad) : '',
    consumoKwh:
      input.consumoKwh != null && Number.isFinite(input.consumoKwh)
        ? `${formatKwh(input.consumoKwh)} kWh`
        : '',
  }
}
