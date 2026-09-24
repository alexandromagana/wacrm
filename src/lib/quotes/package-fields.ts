import type { SolarTier } from './pricing'
import { bimonthlyGenerationKwh } from './finance'
import { financingForTier } from './financing'
import {
  MICROINVERSORES,
  formatKwh,
  formatKwp,
  formatMxn,
  formatMxnCentavos,
  formatQuoteDate,
} from './fields'

// ============================================================
// The strings drawn onto the package sheet: the one-page, price-only
// quote for a customer who asks for a number of panels instead of
// sending a bill.
//
// Built from the tier alone. With no receipt there is no tariff and no
// peso amount paid to CFE, so there is no savings projection and no
// payback — the sheet says nothing it cannot back. What it does say
// comes from the same table and the same Nuvolt rules as the full
// proposal, so the two documents never disagree on a price.
// ============================================================

export type PackageFieldKey =
  | 'folio'
  | 'fecha'
  | 'paneles'
  | 'precio'
  | 'kwp'
  | 'kwhGenerados'
  | 'consumoFrase'
  | 'mensualidad12'
  | 'mensualidad24'
  | 'mensualidad36'
  | 'mensualidad48'
  | 'mensualidad60'
  | 'engancheFrase'

export interface PackageInput {
  tier: SolarTier
  /** Stable per contact and package, so a re-send carries the same folio. */
  folio: string
  now: Date
}

/**
 * Every value for the sheet. A blank string draws nothing, which is how
 * a figure that cannot be computed stays off the page instead of
 * printing a zero — the same contract as `buildQuoteFieldValues`.
 */
export function buildPackageFieldValues(
  input: PackageInput,
): Record<PackageFieldKey, string> {
  const { tier, folio, now } = input
  const financing = financingForTier(tier)
  const mensualidad = (meses: number) => {
    const plan = financing?.esquema.find((p) => p.meses === meses)
    return plan ? formatMxnCentavos(plan.mensualidad) : ''
  }

  return {
    folio,
    fecha: formatQuoteDate(now),
    paneles: String(tier.panels),
    precio: formatMxn(tier.priceMxn),
    kwp: formatKwp(tier.systemKw),
    // Same derivation as `buildFinancials`, so the full proposal and
    // this sheet print the same generation for the same tier.
    kwhGenerados: `${formatKwh(
      bimonthlyGenerationKwh(tier.panels, {
        wattsPerPanel: (tier.systemKw * 1000) / tier.panels,
      }),
    )} kWh`,
    // The tier's own upper bound: the largest bimonthly bill this
    // package was sized for. It is what tells a customer who never sent
    // a bill whether the package they asked for is the right one.
    consumoFrase:
      `Pensado para recibos de hasta ${formatKwh(tier.maxKwh)} kWh al bimestre. ` +
      `Microinversores ${MICROINVERSORES}, estructura K2 Everest grado marino y anclaje químico sellado.`,
    mensualidad12: mensualidad(12),
    mensualidad24: mensualidad(24),
    mensualidad36: mensualidad(36),
    mensualidad48: mensualidad(48),
    mensualidad60: mensualidad(60),
    engancheFrase: financing
      ? `Enganche mínimo ${formatMxnCentavos(financing.engancheMxn)}. ` +
        'La mensualidad ya trae intereses, comisiones e impuestos, y no cambia durante el plazo.'
      : '',
  }
}
