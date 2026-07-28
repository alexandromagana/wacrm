import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * DELETE /api/push/subscriptions/[id]
 *
 * Unregister one of the caller's own devices. The `user_id` filter is
 * belt-and-braces on top of RLS — it keeps the query correct even if
 * this ever moves to a service-role client.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, userId } = await getCurrentAccount()

    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)

    if (error) {
      console.error('[push/subscriptions DELETE] failed:', error)
      return NextResponse.json(
        { error: 'Failed to remove this device' },
        { status: 500 },
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
