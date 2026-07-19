import { NextResponse, after } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

type Params = { params: Promise<{ contactId: string }> }

/**
 * POST   /api/contacts/[contactId]/tags  (agent+)  body: { tag_id }
 * DELETE /api/contacts/[contactId]/tags  (agent+)  body: { tag_id }
 *
 * Tag / untag a contact server-side instead of writing contact_tags
 * straight from the browser. The write itself is the same RLS-scoped
 * insert/delete the UI used to do — but only a server hop can fire the
 * `tag_added` automation trigger, which is what makes follow-up
 * sequences ("quote sent, no reply in 48h") start when an agent tags a
 * contact from the inbox or the contacts page.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    // Same bucket as sends — tag toggles are cheap per-user actions.
    const limit = checkRateLimit(`contact-tag:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { contactId } = await params
    const body = await request.json().catch(() => null)
    const tagId = typeof body?.tag_id === 'string' ? body.tag_id : null
    if (!tagId) {
      return NextResponse.json({ error: 'tag_id required' }, { status: 400 })
    }

    // RLS scopes both lookups to the caller's account — a foreign
    // contact or tag id is simply not found.
    const [{ data: contact }, { data: tag }] = await Promise.all([
      supabase
        .from('contacts')
        .select('id')
        .eq('id', contactId)
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase
        .from('tags')
        .select('id')
        .eq('id', tagId)
        .eq('account_id', accountId)
        .maybeSingle(),
    ])
    if (!contact || !tag) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { data: inserted, error } = await supabase
      .from('contact_tags')
      .upsert(
        { contact_id: contactId, tag_id: tagId },
        { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
      )
      .select('id')
    if (error) {
      console.error('[contact tags] insert failed:', error)
      return NextResponse.json({ error: 'Failed to add tag' }, { status: 500 })
    }

    const added = (inserted ?? []).length > 0
    if (added) {
      // Fire tag-driven automations only for a genuinely new tag, and
      // after the response is sent — a sequence can take seconds
      // (sends, waits) and must not hold up the tag toggle in the UI.
      after(async () => {
        await runAutomationsForTrigger({
          accountId,
          triggerType: 'tag_added',
          contactId,
          context: { tag_id: tagId },
        })
      })
    }

    return NextResponse.json({ success: true, added })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`contact-tag:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { contactId } = await params
    const body = await request.json().catch(() => null)
    const tagId = typeof body?.tag_id === 'string' ? body.tag_id : null
    if (!tagId) {
      return NextResponse.json({ error: 'tag_id required' }, { status: 400 })
    }

    // Ownership check mirrors POST; there is no tag_removed trigger, so
    // the delete is plain bookkeeping.
    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!contact) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { error } = await supabase
      .from('contact_tags')
      .delete()
      .eq('contact_id', contactId)
      .eq('tag_id', tagId)
    if (error) {
      console.error('[contact tags] delete failed:', error)
      return NextResponse.json({ error: 'Failed to remove tag' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
