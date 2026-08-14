import { NextResponse, after } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import type { AutomationTriggerType } from '@/types'
import { pickDealFields } from '@/lib/deals/writable'

type Params = { params: Promise<{ dealId: string }> }

const DEAL_STATUSES = new Set(['open', 'won', 'lost'])

/**
 * PATCH /api/deals/[dealId]  (agent+)
 *   body: any subset of the writable deal fields, plus optional `status`
 *
 * The single write path for an existing deal. Dragging a card on the
 * board, editing the sheet, and marking won/lost all land here, which
 * is the whole point: only a server hop can fire the
 * `deal_stage_changed` / `deal_won` / `deal_lost` triggers, so a human
 * moving a card kicks off the same follow-up an automation would.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`deal-write:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { dealId } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }

    const fields = pickDealFields(body as Record<string, unknown>)
    const rawStatus = (body as Record<string, unknown>).status
    const status = typeof rawStatus === 'string' ? rawStatus : null
    if (status !== null && !DEAL_STATUSES.has(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }
    if (Object.keys(fields).length === 0 && status === null) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    // Read the "before" state so we know which triggers the write earns.
    // Scoped by account_id: RLS covers this too, but the comparison
    // below drives outbound messages, so the row must be provably ours.
    const { data: before } = await supabase
      .from('deals')
      .select('id, stage_id, status, contact_id')
      .eq('id', dealId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!before) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // A destination stage has to sit on a pipeline in this account,
    // otherwise a forged id would move the card onto a foreign board.
    if (fields.stage_id && fields.stage_id !== before.stage_id) {
      const { data: stage } = await supabase
        .from('pipeline_stages')
        .select('id')
        .eq('id', fields.stage_id as string)
        .maybeSingle()
      if (!stage) {
        return NextResponse.json({ error: 'Stage not found' }, { status: 404 })
      }
    }

    const patch: Record<string, unknown> = { ...fields }
    if (status !== null) patch.status = status

    const { error } = await supabase
      .from('deals')
      .update(patch)
      .eq('id', dealId)
      .eq('account_id', accountId)
    if (error) {
      console.error('[deals] update failed:', error)
      return NextResponse.json({ error: 'Failed to update deal' }, { status: 500 })
    }

    // Only genuine transitions fire. Re-saving the sheet without
    // touching the stage, or dropping a card back where it started,
    // must not restart a follow-up sequence.
    const movedTo =
      typeof fields.stage_id === 'string' && fields.stage_id !== before.stage_id
        ? fields.stage_id
        : null
    const becameStatus =
      status !== null && status !== before.status ? status : null

    if (movedTo || becameStatus) {
      const triggers: AutomationTriggerType[] = []
      if (movedTo) triggers.push('deal_stage_changed')
      if (becameStatus === 'won') triggers.push('deal_won')
      if (becameStatus === 'lost') triggers.push('deal_lost')

      // After the response, same contract as the tag route: a sequence
      // can take seconds (sends, waits) and must not hold up the drag.
      after(async () => {
        for (const triggerType of triggers) {
          await runAutomationsForTrigger({
            accountId,
            triggerType,
            contactId: before.contact_id,
            context: {
              deal_id: dealId,
              ...(movedTo
                ? { stage_id: movedTo, from_stage_id: before.stage_id ?? undefined }
                : {}),
            },
          })
        }
      })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/deals/[dealId]  (agent+) — no trigger; nothing to follow up. */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`deal-write:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { dealId } = await params
    const { error } = await supabase
      .from('deals')
      .delete()
      .eq('id', dealId)
      .eq('account_id', accountId)
    if (error) {
      console.error('[deals] delete failed:', error)
      return NextResponse.json({ error: 'Failed to delete deal' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
