import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isAutoLostReason } from '@/lib/deals/lost-reasons'
import { closeConversationWithDeal } from '@/lib/lifecycle/execute'

type Params = { params: Promise<{ conversationId: string }> }

/**
 * POST /api/conversations/[conversationId]/close  (agent+)
 *
 * Accept the lifecycle sweep's "suggested to close" for a chat someone
 * owns: close it and lose the contact's open deal with the suggested
 * `auto_*` reason, exactly as the sweep would have. Keeping the `auto_`
 * reason is deliberate — if the customer writes back, the chat and the
 * deal reopen together (migration 052).
 *
 * The plain status dropdown in the thread header still closes a chat
 * without touching its deal; this route is only the suggestion banner.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`conversation-close:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { conversationId } = await params
    const { data: conversation } = await supabase
      .from('conversations')
      .select('id, contact_id, status, close_suggested_reason')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conversation) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (conversation.status === 'closed') {
      return NextResponse.json({ success: true, closed: false })
    }

    const reason = isAutoLostReason(conversation.close_suggested_reason)
      ? (conversation.close_suggested_reason as string)
      : 'auto_sin_respuesta'

    // The newest open deal, but only from a stage the sweep may close —
    // a deal that moved on to a site visit since the suggestion stays.
    const { data: deals } = await supabase
      .from('deals')
      .select('id, stage_id, stage:pipeline_stages(auto_close)')
      .eq('account_id', accountId)
      .eq('contact_id', conversation.contact_id)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
    const deal = (deals ?? [])[0] as unknown as
      | { id: string; stage_id: string; stage: { auto_close: boolean } | null }
      | undefined

    const result = await closeConversationWithDeal(supabase, {
      accountId,
      conversationId,
      contactId: conversation.contact_id,
      reason,
      deal: deal?.stage?.auto_close ? { id: deal.id, stageId: deal.stage_id } : null,
    })
    if (result.outcome === 'failed') {
      console.error('[conversations] close failed:', result.detail)
      return NextResponse.json({ error: 'Failed to close conversation' }, { status: 500 })
    }

    return NextResponse.json({ success: true, closed: result.outcome === 'done' })
  } catch (err) {
    return toErrorResponse(err)
  }
}
