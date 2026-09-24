import type { SupabaseClient } from '@supabase/supabase-js'
import { QUOTE_SENT_TAG } from '@/lib/ai/lead-status'
import { firstNameOr } from '@/lib/automations/engine'
import { engineSendTemplate } from '@/lib/automations/meta-send'
import type { LifecycleConfig } from './config'
import type { LifecycleDecision, LifecycleSnapshot } from './rules'

export type ActionOutcome = 'done' | 'skipped' | 'failed'

export interface ActionResult {
  outcome: ActionOutcome
  detail?: Record<string, unknown>
}

export interface CloseArgs {
  accountId: string
  conversationId: string
  contactId: string
  /** An `auto_*` reason — the chat and its deal reopen together if the customer writes. */
  reason: string
  /** The open deal to lose alongside the chat; skipped if it moved or closed meanwhile. */
  deal?: { id: string; stageId: string } | null
  /**
   * Compare-and-set guard: only close if `last_customer_message_at` is
   * still this value. Pass the snapshot's value from the sweep so a
   * customer who wrote while the run was in flight is not closed on.
   * Leave undefined when a person is closing by hand.
   */
  expectedLastCustomerMessageAt?: string | null
}

/**
 * Close a chat, lose its deal with the same reason, and drop the
 * "Quote sent" tag so a later re-quote starts the follow-ups afresh
 * (applyQuoteSentTag skips contacts that already carry it). No
 * automation triggers fire: a rule closing a silent prospect must not
 * set off `deal_lost` sequences that message them.
 */
export async function closeConversationWithDeal(
  db: SupabaseClient,
  args: CloseArgs,
): Promise<ActionResult> {
  let closeQuery = db
    .from('conversations')
    .update({ status: 'closed', close_reason: args.reason })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
    .neq('status', 'closed')
  if (args.expectedLastCustomerMessageAt !== undefined) {
    closeQuery =
      args.expectedLastCustomerMessageAt === null
        ? closeQuery.is('last_customer_message_at', null)
        : closeQuery.eq('last_customer_message_at', args.expectedLastCustomerMessageAt)
  }
  const { data: closed, error: closeErr } = await closeQuery.select('id')
  if (closeErr) return { outcome: 'failed', detail: { error: closeErr.message } }
  if (!closed || closed.length === 0) {
    return { outcome: 'skipped', detail: { why: 'changed_since_snapshot' } }
  }

  let dealLost = false
  if (args.deal) {
    const { data: lost, error: dealErr } = await db
      .from('deals')
      .update({ status: 'lost', lost_reason: args.reason })
      .eq('id', args.deal.id)
      .eq('account_id', args.accountId)
      .eq('status', 'open')
      .eq('stage_id', args.deal.stageId)
      .select('id')
    if (dealErr) {
      // The chat is closed; report the deal miss rather than undo it.
      return { outcome: 'done', detail: { deal_error: dealErr.message } }
    }
    dealLost = (lost?.length ?? 0) > 0
  }

  const { data: tag } = await db
    .from('tags')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('name', QUOTE_SENT_TAG.name)
    .maybeSingle()
  if (tag?.id) {
    await db.from('contact_tags').delete().eq('contact_id', args.contactId).eq('tag_id', tag.id)
  }

  return { outcome: 'done', detail: { deal_lost: dealLost } }
}

export async function sendReminder(
  snap: LifecycleSnapshot,
  cfg: LifecycleConfig,
  senderUserId: string | undefined,
): Promise<ActionResult> {
  if (!senderUserId) {
    return { outcome: 'failed', detail: { error: 'WhatsApp not configured for this account' } }
  }
  try {
    const sent = await engineSendTemplate({
      accountId: snap.accountId,
      userId: senderUserId,
      conversationId: snap.conversationId,
      contactId: snap.contactId,
      templateName: cfg.reminderTemplate.name,
      language: cfg.reminderTemplate.language,
      params: [firstNameOr(snap.contactName, 'cliente')],
    })
    return { outcome: 'done', detail: { whatsapp_message_id: sent.whatsapp_message_id } }
  } catch (err) {
    return { outcome: 'failed', detail: { error: err instanceof Error ? err.message : String(err) } }
  }
}

export async function suggestClose(
  db: SupabaseClient,
  snap: LifecycleSnapshot,
  reason: string,
): Promise<ActionResult> {
  const { data, error } = await db
    .from('conversations')
    .update({ close_suggested_at: new Date().toISOString(), close_suggested_reason: reason })
    .eq('id', snap.conversationId)
    .eq('account_id', snap.accountId)
    .neq('status', 'closed')
    .is('close_suggested_at', null)
    .select('id')
  if (error) return { outcome: 'failed', detail: { error: error.message } }
  return data && data.length > 0
    ? { outcome: 'done' }
    : { outcome: 'skipped', detail: { why: 'changed_since_snapshot' } }
}

export async function executeDecision(
  db: SupabaseClient,
  snap: LifecycleSnapshot,
  decision: LifecycleDecision,
  cfg: LifecycleConfig,
  senderUserId: string | undefined,
): Promise<ActionResult> {
  switch (decision.action) {
    case 'close':
      return closeConversationWithDeal(db, {
        accountId: snap.accountId,
        conversationId: snap.conversationId,
        contactId: snap.contactId,
        reason: decision.reason,
        deal: snap.deal ? { id: snap.deal.id, stageId: snap.deal.stageId } : null,
        expectedLastCustomerMessageAt: snap.lastCustomerMessageAt,
      })
    case 'remind':
      return sendReminder(snap, cfg, senderUserId)
    case 'suggest':
      return suggestClose(db, snap, decision.reason)
    default:
      return { outcome: 'skipped' }
  }
}
