/**
 * The deal columns a client is allowed to set.
 *
 * Deals are written through API routes rather than straight from the
 * browser so that stage and status changes can fire automation
 * triggers. That only helps if the payload cannot smuggle in the
 * columns the server owns — `account_id` and `user_id` are tenancy and
 * audit, and `status` moves through its own endpoint so won/lost fire
 * the right trigger.
 */
export const DEAL_WRITABLE_FIELDS = [
  'title',
  'value',
  'currency',
  'contact_id',
  'pipeline_id',
  'stage_id',
  'assigned_to',
  'notes',
  'panel_count',
  'technical_visit_at',
  'installation_date',
  'quote_url',
] as const

export type DealWritableField = (typeof DEAL_WRITABLE_FIELDS)[number]

/**
 * Keep only recognised columns. Absent keys stay absent rather than
 * becoming null, so a PATCH that sends just `{ stage_id }` does not
 * blank out the rest of the card.
 */
export function pickDealFields(
  body: Record<string, unknown>,
): Partial<Record<DealWritableField, unknown>> {
  const out: Partial<Record<DealWritableField, unknown>> = {}
  for (const key of DEAL_WRITABLE_FIELDS) {
    if (key in body) out[key] = body[key]
  }
  return out
}
