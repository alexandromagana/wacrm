import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { QUOTE_ASSETS_BUCKET } from '@/lib/quotes/templates'

interface Params {
  params: Promise<{ templateId: string }>
}

/**
 * DELETE /api/quotes/templates/[templateId]  (admin+)
 *
 * Quotes generated from this template keep their output document; only
 * the reference goes null.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { templateId } = await params
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(
      `quote-templates:${userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { data: template } = await supabase
      .from('quote_templates')
      .select('storage_path')
      .eq('id', templateId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!template) {
      return NextResponse.json(
        { error: 'Plantilla no encontrada' },
        { status: 404 },
      )
    }

    const { error } = await supabase
      .from('quote_templates')
      .delete()
      .eq('id', templateId)
      .eq('account_id', accountId)
    if (error) {
      console.error('[quotes/templates DELETE] error:', error)
      return NextResponse.json(
        { error: 'No se pudo eliminar la plantilla' },
        { status: 500 },
      )
    }

    // Best effort: the row is what the app reads, so a stranded file is
    // untidy rather than broken.
    await supabase.storage
      .from(QUOTE_ASSETS_BUCKET)
      .remove([template.storage_path])

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
