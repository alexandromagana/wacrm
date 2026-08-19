import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  parseProjectTypeBody,
  PROJECT_TYPE_SELECT,
  sortTiers,
  toTierRow,
} from '@/lib/quotes/project-types'

/**
 * GET /api/quotes/project-types
 *
 * The account's project types with their price ladders (any member —
 * the generator needs the list; only admins may change it).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('quote_project_types')
      .select(PROJECT_TYPE_SELECT)
      .eq('account_id', accountId)
      .order('name')
    if (error) {
      console.error('[quotes/project-types GET] error:', error)
      return NextResponse.json(
        { error: 'No se pudieron cargar los tipos de proyecto' },
        { status: 500 },
      )
    }
    return NextResponse.json({ projectTypes: sortTiers(data ?? []) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/quotes/project-types  (admin+)
 *
 * Create a project type and its tiers.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(
      `quote-types:${userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const parsed = parseProjectTypeBody(body)
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    const { fields, tiers } = parsed

    const { data: created, error } = await supabase
      .from('quote_project_types')
      .insert({ ...fields, account_id: accountId, created_by: userId })
      .select('id')
      .single()
    if (error || !created) {
      // The only constraint a user can realistically trip.
      if (error?.code === '23505') {
        return NextResponse.json(
          { error: 'Ya existe un tipo de proyecto con ese nombre.' },
          { status: 409 },
        )
      }
      console.error('[quotes/project-types POST] insert error:', error)
      return NextResponse.json(
        { error: 'No se pudo guardar el tipo de proyecto' },
        { status: 500 },
      )
    }

    const { error: tiersError } = await supabase
      .from('quote_rate_tiers')
      .insert(tiers.map((t) => toTierRow(created.id, t)))
    if (tiersError) {
      // Leaving a project type with no prices behind would show up as a
      // type that silently refuses to quote, so undo it.
      await supabase.from('quote_project_types').delete().eq('id', created.id)
      console.error('[quotes/project-types POST] tiers error:', tiersError)
      return NextResponse.json(
        { error: 'No se pudieron guardar los rangos de precio' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, id: created.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
