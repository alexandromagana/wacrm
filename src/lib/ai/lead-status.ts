import type { SupabaseClient } from '@supabase/supabase-js'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import type { LeadStatus } from './types'

/**
 * Contact tags backing the AI's lead-temperature qualification (the
 * `[ESTATUS]`/`[STATUS]` marker in the business prompt). Named in
 * English to match the rest of the UI. Find-or-create per account:
 * renaming one in Settings → Fields & tags simply orphans it, and the
 * next qualification recreates the canonical name.
 */
export const LEAD_STATUS_TAGS: Record<LeadStatus, { name: string; color: string }> = {
  hot: { name: 'Hot lead', color: '#ef4444' },
  warm: { name: 'Warm lead', color: '#f59e0b' },
  cold: { name: 'Cold lead', color: '#64748b' },
}

/**
 * Persist the model's lead qualification as a contact tag: ensure the
 * account has the status tag, drop any other status tag on the contact
 * (one temperature at a time), and link the new one. Fires the
 * `tag_added` automation trigger only when the status actually changed,
 * so tag-driven follow-ups don't re-fire on every single reply.
 *
 * Never throws — qualification is a side effect and must not break the
 * customer-facing send (mirrors the `logAiUsage` contract).
 */
export async function applyLeadStatusTag(
  db: SupabaseClient,
  args: {
    accountId: string
    /** Audit owner for a freshly-created tag row (tags.user_id is NOT NULL). */
    userId: string
    contactId: string
    status: LeadStatus
  },
): Promise<void> {
  const { accountId, userId, contactId, status } = args
  try {
    const names = Object.values(LEAD_STATUS_TAGS).map((t) => t.name)
    const { data: existing, error: tagErr } = await db
      .from('tags')
      .select('id, name')
      .eq('account_id', accountId)
      .in('name', names)
    if (tagErr) throw tagErr

    const byName = new Map(
      (existing ?? []).map((t) => [t.name as string, t.id as string]),
    )
    const target = LEAD_STATUS_TAGS[status]
    let targetId = byName.get(target.name) ?? null
    if (!targetId) {
      const { data: created, error: insErr } = await db
        .from('tags')
        .insert({
          account_id: accountId,
          user_id: userId,
          name: target.name,
          color: target.color,
        })
        .select('id')
        .single()
      if (insErr) throw insErr
      targetId = created.id as string
    }

    // A contact holds one temperature at a time — drop the others.
    const otherIds = [...byName.entries()]
      .filter(([name]) => name !== target.name)
      .map(([, id]) => id)
    if (otherIds.length > 0) {
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', contactId)
        .in('tag_id', otherIds)
    }

    // Already at this status → nothing new, and no trigger to fire.
    const { data: already } = await db
      .from('contact_tags')
      .select('id')
      .eq('contact_id', contactId)
      .eq('tag_id', targetId)
      .maybeSingle()
    if (already) return

    const { error: linkErr } = await db.from('contact_tags').upsert(
      { contact_id: contactId, tag_id: targetId },
      { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
    )
    if (linkErr) throw linkErr

    // Let tag-driven automations chain off the new status (the engine
    // matches trigger_config.tag_id against this context).
    await runAutomationsForTrigger({
      accountId,
      triggerType: 'tag_added',
      contactId,
      context: { tag_id: targetId },
    })
  } catch (err) {
    console.error('[ai lead-status] failed to apply status tag:', err)
  }
}
