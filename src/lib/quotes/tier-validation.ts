import type { SolarTier } from './pricing'

// ============================================================
// Validation for an account-authored price table.
//
// Shared by the editor and the API that receives it, so the message a
// user reads while typing is the same one the server would have
// rejected them with. Pure, and free of any DB/HTTP import, for the
// same reason the rest of this module is.
//
// The check that matters is overlap: `lookupSolarTier` takes the FIRST
// range a consumption falls in, so two overlapping rows don't error —
// they silently make one row's prices unreachable, and nobody notices
// until a customer is quoted from the wrong one.
// ============================================================

/** A tier as typed into the editor, before it is a `SolarTier`. */
export type TierInput = SolarTier

/** Human-readable problems, in the order a reader would meet them. */
export function validateTierTable(tiers: readonly TierInput[]): string[] {
  const errors: string[] = []

  if (tiers.length === 0) {
    return ['Agrega al menos un rango de consumo.']
  }

  for (const t of tiers) {
    const label = `Rango ${t.minKwh}–${t.maxKwh}`
    if (!Number.isFinite(t.minKwh) || t.minKwh < 0) {
      errors.push(`${label}: el consumo mínimo no puede ser negativo.`)
    }
    if (!Number.isFinite(t.maxKwh) || t.maxKwh < t.minKwh) {
      errors.push(`${label}: el máximo debe ser mayor o igual al mínimo.`)
    }
    if (!Number.isFinite(t.panels) || t.panels <= 0) {
      errors.push(`${label}: el número de paneles debe ser mayor a cero.`)
    }
    if (!Number.isFinite(t.systemKw) || t.systemKw <= 0) {
      errors.push(`${label}: el tamaño del sistema debe ser mayor a cero.`)
    }
    if (!Number.isFinite(t.priceMxn) || t.priceMxn <= 0) {
      errors.push(`${label}: el precio debe ser mayor a cero.`)
    }
  }

  const sorted = [...tiers].sort((a, b) => a.minKwh - b.minKwh)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const curr = sorted[i]
    if (curr.minKwh <= prev.maxKwh) {
      errors.push(
        `Los rangos ${prev.minKwh}–${prev.maxKwh} y ${curr.minKwh}–${curr.maxKwh} se traslapan.`,
      )
    }
  }

  return errors
}
