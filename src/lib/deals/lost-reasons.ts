/**
 * Why a deal was lost (`deals.lost_reason`, migration 052).
 *
 * Two families that must never overlap:
 *   - manual reasons, picked by a person in the deal sheet;
 *   - `auto_*` reasons, written only by the lifecycle sweep
 *     (src/lib/lifecycle/). The DB trigger that reopens a deal when the
 *     customer writes back keys off that prefix, so a manual reason
 *     starting with `auto_` would make a person's decision undo itself.
 *
 * A manual "other" can carry free text instead of a key; it is stored
 * as-is and shown verbatim.
 */

export const MANUAL_LOST_REASONS = [
  'precio',
  'competencia',
  'no_califica',
  'no_interesado',
  'financiamiento',
  'otro',
] as const

export const AUTO_LOST_REASONS = [
  'auto_sin_respuesta_seguimientos',
  'auto_sin_recibo',
  'auto_sin_contacto',
  /** Silent, but no automatic rule fits — only ever suggested. */
  'auto_sin_respuesta',
] as const

export type ManualLostReason = (typeof MANUAL_LOST_REASONS)[number]
export type AutoLostReason = (typeof AUTO_LOST_REASONS)[number]
export type KnownLostReason = ManualLostReason | AutoLostReason

const KNOWN = new Set<string>([...MANUAL_LOST_REASONS, ...AUTO_LOST_REASONS])

export const LOST_REASON_MAX_LENGTH = 200

export function isAutoLostReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith('auto_')
}

export function isKnownLostReason(reason: string | null | undefined): reason is KnownLostReason {
  return typeof reason === 'string' && KNOWN.has(reason)
}

/**
 * Validate a reason sent from the deal sheet. Returns the value to
 * store, `null` for "no reason given", or `undefined` when the input is
 * not acceptable (the route answers 400).
 */
export function parseManualLostReason(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value === '') return null
  if (value.length > LOST_REASON_MAX_LENGTH) return undefined
  if (isAutoLostReason(value)) return undefined
  return value
}
