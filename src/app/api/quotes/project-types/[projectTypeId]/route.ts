import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseProjectTypeBody, toTierRow } from '@/lib/quotes/project-types'

interface Params {
  params: Promise<{ projectTypeId: string }>
}

/**
 * PATCH /api/quotes/project-types/[projectTypeId]  (admin+)
 *
 * Update the type and replace its price ladder wholesale.
 *
 * The tiers are deleted and re-inserted rather than diffed by id. That
 * is safe because `quotes` snapshots the numbers it was generated from
 * — a past quote keeps its price when the tier it came from is
 * replaced, losing only the `tier_id` cross-reference.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { projectTypeId } = await params
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

    // account_id is redundant against RLS but makes a cross-account id
    // a clean 404 instead of a silent zero-row update.
    const { data: updated, error } = await supabase
      .from('quote_project_types')
      .update(fields)
      .eq('id', projectTypeId)
      .eq('account_id', accountId)
      .select('id')
      .maybeSingle()
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'Ya existe un tipo de proyecto con ese nombre.' },
          { status: 409 },
        )
      }
      console.error('[quotes/project-types PATCH] update error:', error)
      return NextResponse.json(
        { error: 'No se pudo actualizar el tipo de proyecto' },
        { status: 500 },
      )
    }
    if (!updated) {
      return NextResponse.json(
        { error: 'Tipo de proyecto no encontrado' },
        { status: 404 },
      )
    }

    const { error: deleteError } = await supabase
      .from('quote_rate_tiers')
      .delete()
      .eq('project_type_id', projectTypeId)
    if (deleteError) {
      console.error('[quotes/project-types PATCH] tier delete error:', deleteError)
      return NextResponse.json(
        { error: 'No se pudieron actualizar los rangos de precio' },
        { status: 500 },
      )
    }

    const { error: insertError } = await supabase
      .from('quote_rate_tiers')
      .insert(tiers.map((t) => toTierRow(projectTypeId, t)))
    if (insertError) {
      // The old ladder is already gone, so say so plainly rather than
      // letting the admin believe the previous prices survived.
      console.error('[quotes/project-types PATCH] tier insert error:', insertError)
      return NextResponse.json(
        {
          error:
            'No se pudieron guardar los rangos de precio. El tipo de proyecto quedó sin rangos — vuelve a guardarlos.',
        },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/quotes/project-types/[projectTypeId]  (admin+)
 *
 * Tiers cascade. Quotes generated from this type keep their snapshotted
 * numbers and simply lose the reference.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { projectTypeId } = await params
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(
      `quote-types:${userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { error } = await supabase
      .from('quote_project_types')
      .delete()
      .eq('id', projectTypeId)
      .eq('account_id', accountId)
    if (error) {
      console.error('[quotes/project-types DELETE] error:', error)
      return NextResponse.json(
        { error: 'No se pudo eliminar el tipo de proyecto' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
