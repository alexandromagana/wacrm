import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { uploadServerMedia } from '@/lib/storage/upload-server'
import {
  inspectTemplateTags,
  TemplateParseError,
} from '@/lib/quotes/template-render'
import {
  QUOTE_ASSETS_BUCKET,
  TEMPLATE_MAX_BYTES,
  templateFileType,
} from '@/lib/quotes/templates'

/**
 * GET /api/quotes/templates
 *
 * The account's uploaded proposal templates (any member).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('quote_templates')
      .select('*')
      .eq('account_id', accountId)
      .order('name')
    if (error) {
      console.error('[quotes/templates GET] error:', error)
      return NextResponse.json(
        { error: 'No se pudieron cargar las plantillas' },
        { status: 500 },
      )
    }
    return NextResponse.json({ templates: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/quotes/templates  (admin+, multipart/form-data)
 *
 * Upload a .docx/.pptx template.
 *
 * Unlike every other upload in the app, this one goes through the
 * server rather than straight from the browser to Storage: the file has
 * to be parsed to list its {{tags}}, and a file that isn't a readable
 * template should be rejected before it is stored, not after.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(
      `quote-templates:${userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    const rawName = form?.get('name')
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'Adjunta un archivo .docx o .pptx.' },
        { status: 400 },
      )
    }

    const fileType = templateFileType(file.type, file.name)
    if (!fileType) {
      return NextResponse.json(
        { error: 'Solo se aceptan archivos de Word (.docx) o PowerPoint (.pptx).' },
        { status: 400 },
      )
    }
    if (file.size > TEMPLATE_MAX_BYTES) {
      return NextResponse.json(
        { error: 'El archivo supera el límite de 25 MB.' },
        { status: 400 },
      )
    }

    const name =
      typeof rawName === 'string' && rawName.trim()
        ? rawName.trim()
        : file.name.replace(/\.[^.]+$/, '')

    const bytes = Buffer.from(await file.arrayBuffer())

    let detectedTags: string[]
    try {
      detectedTags = inspectTemplateTags(bytes)
    } catch (err) {
      if (err instanceof TemplateParseError) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      throw err
    }

    const { publicUrl, path } = await uploadServerMedia({
      db: supabase,
      bucket: QUOTE_ASSETS_BUCKET,
      accountId,
      bytes,
      fileName: file.name,
      contentType: file.type,
    })

    const { data: created, error } = await supabase
      .from('quote_templates')
      .insert({
        account_id: accountId,
        created_by: userId,
        name,
        file_type: fileType,
        storage_path: path,
        storage_url: publicUrl,
        detected_tags: detectedTags,
      })
      .select('*')
      .single()
    if (error || !created) {
      await supabase.storage.from(QUOTE_ASSETS_BUCKET).remove([path])
      if (error?.code === '23505') {
        return NextResponse.json(
          { error: 'Ya existe una plantilla con ese nombre.' },
          { status: 409 },
        )
      }
      console.error('[quotes/templates POST] insert error:', error)
      return NextResponse.json(
        { error: 'No se pudo guardar la plantilla' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, template: created })
  } catch (err) {
    return toErrorResponse(err)
  }
}
