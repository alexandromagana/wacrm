import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/push/subscriptions
 *
 * The caller's own registered devices, for the settings screen.
 *
 * `endpoint` / `p256dh` / `auth` are deliberately NOT selected: they
 * are the credentials for pushing to that browser, and the UI only
 * needs enough to say "Chrome on Windows, added last Tuesday".
 */
export async function GET() {
  try {
    const { supabase, userId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('id, user_agent, created_at, last_seen_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[push/subscriptions GET] fetch failed:', error)
      return NextResponse.json(
        { error: 'Failed to load devices' },
        { status: 500 },
      )
    }

    return NextResponse.json({ subscriptions: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
