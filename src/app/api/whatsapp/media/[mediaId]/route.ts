import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  fetchInboundMediaFromMeta,
  isValidMediaId,
  readInboundMedia,
  storeInboundMedia,
} from '@/lib/storage/inbound-media'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }
    // The id becomes part of a storage path below.
    if (!isValidMediaId(mediaId)) {
      return NextResponse.json({ error: 'Invalid media ID' }, { status: 400 })
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Our own copy first. Everything the webhook archived is served from
    // here, for good, without a round trip to Meta. Read through the
    // caller's session so the bucket's policy scopes it to their account.
    const archived = await readInboundMedia({ db: supabase, accountId, mediaId })
    if (archived) {
      return new Response(archived, {
        status: 200,
        headers: {
          'Content-Type': archived.type || 'application/octet-stream',
          // `private`: a customer's document behind a login must never
          // sit in a shared cache. A media id never changes bytes.
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      })
    }

    // No copy yet — the file arrived before inbound media was archived,
    // or the webhook's copy failed. Only Meta has it now, and only until
    // 7 days after it arrived.
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    const { bytes, contentType } = await fetchInboundMediaFromMeta({
      mediaId,
      accessToken,
    })

    // Keep what we just fetched, so this is the last time the file
    // depends on Meta. After the response: the viewer shouldn't wait on
    // the upload, and a failed copy costs nothing the next view can't
    // retry. Service role because the bucket has no write policy.
    after(async () => {
      try {
        await storeInboundMedia({
          db: supabaseAdmin(),
          accountId,
          mediaId,
          bytes,
          contentType,
        })
      } catch (err) {
        console.error(`[whatsapp media] archive of ${mediaId} failed:`, err)
      }
    })

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
