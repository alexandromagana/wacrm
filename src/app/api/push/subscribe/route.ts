import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * POST /api/push/subscribe
 *
 * Register the calling browser as a push target. Any member may do
 * this for themselves — it is a personal device setting, like the
 * theme, not an account-wide admin action.
 *
 * Body is a PushSubscription as the browser serialises it:
 *   { endpoint, keys: { p256dh, auth }, userAgent? }
 */
export async function POST(request: Request) {
  try {
    const { supabase, userId, accountId } = await getCurrentAccount()

    const body = await request.json().catch(() => null)
    const endpoint = body?.endpoint
    const p256dh = body?.keys?.p256dh
    const auth = body?.keys?.auth

    if (
      typeof endpoint !== 'string' ||
      typeof p256dh !== 'string' ||
      typeof auth !== 'string' ||
      !endpoint ||
      !p256dh ||
      !auth
    ) {
      return NextResponse.json(
        { error: 'endpoint and keys.p256dh / keys.auth are required' },
        { status: 400 },
      )
    }

    // On a shared office machine, the browser hands back the SAME
    // endpoint no matter who is signed in. Without this, the teammate
    // who registered first keeps receiving the current user's
    // notifications on that machine. Their row is stale by definition —
    // that subscription now belongs to whoever is signed in here.
    const { error: cleanupError } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)
      .neq('user_id', userId)
    if (cleanupError) {
      console.error('[push/subscribe] stale-owner cleanup failed:', cleanupError)
    }

    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        account_id: accountId,
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        user_agent:
          typeof body?.userAgent === 'string'
            ? body.userAgent.slice(0, 500)
            : null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,user_id,endpoint' },
    )

    if (error) {
      console.error('[push/subscribe] upsert failed:', error)
      return NextResponse.json(
        { error: 'Failed to register this device' },
        { status: 500 },
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
