import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { sendPushToUser } from '@/lib/push/send'

/**
 * POST /api/push/test
 *
 * Fire a push at the caller's own devices so they can confirm the whole
 * chain works — permission, service worker, VAPID keys, OS delivery —
 * without waiting on a real customer message.
 *
 * Uses the service-role client because that is the path production
 * pushes take; testing through a different client would prove less.
 */
export async function POST() {
  try {
    const { userId, accountId } = await getCurrentAccount()

    const result = await sendPushToUser(
      supabaseAdmin(),
      accountId,
      userId,
      'message_received',
      {
        title: 'Gama Energía',
        body: 'Notificación de prueba — todo funciona.',
        url: '/inbox',
        tag: 'push-test',
      },
      // An explicit "test my setup" request must not be swallowed by a
      // muted event type — that would look exactly like a broken
      // service worker.
      { ignorePrefs: true },
    )

    if (result.sent === 0) {
      return NextResponse.json(
        {
          error:
            'No devices received the notification. Enable notifications on this device first, and check the server has VAPID keys configured.',
          ...result,
        },
        { status: 409 },
      )
    }

    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return toErrorResponse(err)
  }
}
