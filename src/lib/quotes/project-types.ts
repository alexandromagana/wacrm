import type { QuoteProjectType, QuoteRateTier } from '@/types'
import type { SolarTier } from './pricing'
import type { FinanceConstants } from './finance'
import { validateTierTable, type TierInput } from './tier-validation'

// ============================================================
// Turning `quote_project_types` rows into what the pricing engine
// takes, and request bodies into what the tables take.
//
// Every numeric column here is NUMERIC in Postgres, and supabase-js
// hands those back as STRINGS to preserve precision. Feeding one
// straight to `resolveQuote` doesn't throw — it silently compares a
// string against a number and quotes the wrong tier. Hence `num()`
// on every crossing, in both directions.
// ============================================================

export const PROJECT_TYPE_SELECT = '*, quote_rate_tiers(*)'

const CFE_HINTS = ['Casa', 'Negocio', 'Industria'] as const

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
}

/** Tiers in ascending kWh order — the order `lookupSolarTier` reads. */
export function sortTiers<T extends { quote_rate_tiers?: QuoteRateTier[] }>(
  rows: T[],
): T[] {
  for (const row of rows) {
    row.quote_rate_tiers?.sort((a, b) => num(a.min_kwh) - num(b.min_kwh))
  }
  return rows
}

/** The project type's price ladder, as the pricing engine wants it. */
export function toSolarTiers(rows: readonly QuoteRateTier[]): SolarTier[] {
  return [...rows]
    .map((r) => ({
      minKwh: num(r.min_kwh),
      maxKwh: num(r.max_kwh),
      panels: num(r.panels),
      systemKw: num(r.system_kw),
      priceMxn: num(r.price_mxn),
    }))
    .sort((a, b) => a.minKwh - b.minKwh)
}

/** The project type's own financial assumptions. */
export function toFinanceConstants(row: QuoteProjectType): FinanceConstants {
  return {
    annualInflation: num(row.annual_inflation),
    fixedChargeBimonthlyMxn: num(row.fixed_charge_bimonthly_mxn),
    peakSunHours: num(row.peak_sun_hours),
    systemEfficiency: num(row.system_efficiency),
    horizonYears: num(row.horizon_years),
  }
}

/** The row a tier maps back to when written. */
export function toTierRow(projectTypeId: string, tier: TierInput) {
  return {
    project_type_id: projectTypeId,
    min_kwh: tier.minKwh,
    max_kwh: tier.maxKwh,
    panels: tier.panels,
    system_kw: tier.systemKw,
    price_mxn: tier.priceMxn,
  }
}

export interface ProjectTypeFields {
  name: string
  cfe_property_type_hint: string | null
  annual_inflation: number
  fixed_charge_bimonthly_mxn: number
  peak_sun_hours: number
  system_efficiency: number
  horizon_years: number
}

export type ParsedProjectType =
  | { fields: ProjectTypeFields; tiers: TierInput[] }
  | { error: string }

/**
 * Validate a create/update body. Returns the rows to write, or the one
 * message to show the user — the same message the editor shows while
 * they type, since both sides call `validateTierTable`.
 */
export function parseProjectTypeBody(body: unknown): ParsedProjectType {
  if (!body || typeof body !== 'object') {
    return { error: 'Solicitud inválida.' }
  }
  const b = body as Record<string, unknown>

  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return { error: 'El nombre del tipo de proyecto es obligatorio.' }

  const hint =
    typeof b.cfe_property_type_hint === 'string' && b.cfe_property_type_hint
      ? b.cfe_property_type_hint
      : null
  if (hint && !CFE_HINTS.includes(hint as (typeof CFE_HINTS)[number])) {
    return { error: 'Tipo de propiedad CFE inválido.' }
  }

  const rawTiers = Array.isArray(b.tiers) ? b.tiers : []
  const tiers: TierInput[] = rawTiers.map((t) => {
    const r = (t ?? {}) as Record<string, unknown>
    return {
      minKwh: num(r.minKwh),
      maxKwh: num(r.maxKwh),
      panels: num(r.panels),
      systemKw: num(r.systemKw),
      priceMxn: num(r.priceMxn),
    }
  })

  const errors = validateTierTable(tiers)
  if (errors.length > 0) return { error: errors.join(' ') }

  const constants = {
    annual_inflation: num(b.annual_inflation),
    fixed_charge_bimonthly_mxn: num(b.fixed_charge_bimonthly_mxn),
    peak_sun_hours: num(b.peak_sun_hours),
    system_efficiency: num(b.system_efficiency),
    horizon_years: num(b.horizon_years),
  }
  for (const [key, value] of Object.entries(constants)) {
    if (!Number.isFinite(value)) {
      return { error: `El valor de "${key}" no es un número válido.` }
    }
  }
  if (constants.annual_inflation < 0 || constants.annual_inflation >= 1) {
    return { error: 'La inflación anual debe estar entre 0% y 100%.' }
  }
  if (constants.system_efficiency <= 0 || constants.system_efficiency > 1) {
    return { error: 'La eficiencia del sistema debe estar entre 1% y 100%.' }
  }
  if (constants.peak_sun_hours <= 0) {
    return { error: 'Las horas sol pico deben ser mayores a cero.' }
  }
  if (constants.horizon_years <= 0 || constants.horizon_years > 50) {
    return { error: 'El horizonte de proyección debe estar entre 1 y 50 años.' }
  }
  if (constants.fixed_charge_bimonthly_mxn < 0) {
    return { error: 'El cargo fijo bimestral no puede ser negativo.' }
  }

  return {
    fields: { name, cfe_property_type_hint: hint, ...constants },
    tiers,
  }
}
