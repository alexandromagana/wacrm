import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { pickDealFields } from '@/lib/deals/writable'

/**
 * POST /api/deals  (agent+)
 *
 * Create a deal server-side instead of inserting from the browser. The
 * insert itself is the same RLS-scoped write the board used to do — the
 * point of the server hop is that deals now have one entry point, which
 * is what lets stage and status changes fire automation triggers (see
 * PATCH /api/deals/[dealId]).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`deal-write:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }

    const fields = pickDealFields(body as Record<string, unknown>)
    if (!fields.pipeline_id || !fields.stage_id) {
      return NextResponse.json(
        { error: 'pipeline_id and stage_id are required' },
        { status: 400 },
      )
    }

    // The stage must belong to this account's pipeline. RLS already
    // scopes the insert, but a forged stage_id would otherwise put the
    // card on a board the caller cannot see.
    const { data: stage } = await supabase
      .from('pipeline_stages')
      .select('id, pipeline_id')
      .eq('id', fields.stage_id)
      .maybeSingle()
    if (!stage || stage.pipeline_id !== fields.pipeline_id) {
      return NextResponse.json({ error: 'Stage not found' }, { status: 404 })
    }

    const { data: created, error } = await supabase
      .from('deals')
      .insert({
        ...fields,
        account_id: accountId,
        user_id: userId,
        status: 'open',
      })
      .select('id')
      .single()
    if (error) {
      console.error('[deals] insert failed:', error)
      return NextResponse.json({ error: 'Failed to create deal' }, { status: 500 })
    }

    return NextResponse.json({ success: true, id: created.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
