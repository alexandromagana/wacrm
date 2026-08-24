import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The handful of templates the 2026-08-24 audit found being sent outside
 * the tag state their own automations require — the exact pattern behind
 * the "seguimiento a quien ya cotizó" and duplicate-send complaints.
 * Keyed by template name (not template_group): "Seguimiento" bundles two
 * semantically different templates — gama_seguimiento_lead gates on a
 * fresh, untouched lead, the other three gate on an active quote — so a
 * group-level rule would flag the wrong half either way.
 */
const RISK_TAG_BY_TEMPLATE: Record<string, string> = {
  gama_seguimiento_lead: 'FB Pendiente WA',
  recordatorio_recibo: 'FB Pendiente WA',
  seguimiento_coti: 'Quote sent',
  seguimiento_cotizacion: 'Quote sent',
  seguimiento_c: 'Quote sent',
  sin_respuesta: 'Quote sent',
}

export interface TemplateSendRisk {
  reason: string
}

/**
 * Best-effort guard for manual and broadcast template sends: flags a send
 * that doesn't match the tag state the corresponding automation would
 * have required. Not a hard rule — a human may have a good reason (the
 * tag is stale, the contact asked directly) — callers surface this as a
 * confirmation, not a block.
 */
export async function checkTemplateSendRisk(
  supabase: SupabaseClient,
  args: { accountId: string; contactId: string; templateName: string },
): Promise<TemplateSendRisk | null> {
  const requiredTagName = RISK_TAG_BY_TEMPLATE[args.templateName]
  if (!requiredTagName) return null

  const { data: tag } = await supabase
    .from('tags')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('name', requiredTagName)
    .maybeSingle()
  // The account renamed or never created this tag — nothing to check
  // against, so don't block on a tag that no longer means anything here.
  if (!tag) return null

  const { count } = await supabase
    .from('contact_tags')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', args.contactId)
    .eq('tag_id', tag.id)
  if ((count ?? 0) > 0) return null

  return {
    reason: `Este contacto no tiene el tag "${requiredTagName}" — esta plantilla normalmente solo se envía a contactos que sí lo tienen.`,
  }
}

export interface BatchTemplateSendRisk {
  requiredTagName: string
  riskyContactIds: Set<string>
}

/**
 * Broadcast-shaped variant of {@link checkTemplateSendRisk}: one query
 * against the required tag instead of one per recipient, so a 1000-
 * contact audience doesn't mean 1000 round trips.
 */
export async function checkBatchTemplateSendRisk(
  supabase: SupabaseClient,
  args: { accountId: string; contactIds: string[]; templateName: string },
): Promise<BatchTemplateSendRisk | null> {
  const requiredTagName = RISK_TAG_BY_TEMPLATE[args.templateName]
  if (!requiredTagName || args.contactIds.length === 0) return null

  const { data: tag } = await supabase
    .from('tags')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('name', requiredTagName)
    .maybeSingle()
  if (!tag) return null

  // PostgREST's `.in()` is safe well past 1000 items for this query
  // shape (single column, no joins), but page defensively anyway.
  const taggedSet = new Set<string>()
  const PAGE = 500
  for (let i = 0; i < args.contactIds.length; i += PAGE) {
    const slice = args.contactIds.slice(i, i + PAGE)
    const { data } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .eq('tag_id', tag.id)
      .in('contact_id', slice)
    for (const row of data ?? []) taggedSet.add(row.contact_id as string)
  }

  const riskyContactIds = new Set(
    args.contactIds.filter((id) => !taggedSet.has(id)),
  )
  if (riskyContactIds.size === 0) return null

  return { requiredTagName, riskyContactIds }
}
