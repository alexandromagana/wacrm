import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import type { PushEvent } from '@/lib/push/send'

const EVENTS: PushEvent[] = [
  'message_received',
  'handoff',
  'conversation_assigned',
  'unanswered',
]

/** Absent key means opted in — matches the fan-out's reading in send.ts. */
function normalise(raw: unknown): Record<PushEvent, boolean> {
  const prefs = (raw ?? {}) as Record<string, unknown>
  return Object.fromEntries(
    EVENTS.map((event) => [event, prefs[event] !== false]),
  ) as Record<PushEvent, boolean>
}

/** GET /api/push/prefs — the caller's per-event notification opt-ins. */
export async function GET() {
  try {
    const { supabase, userId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('profiles')
      .select('push_prefs')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) {
      console.error('[push/prefs GET] fetch failed:', error)
      return NextResponse.json(
        { error: 'Failed to load notification preferences' },
        { status: 500 },
      )
    }

    return NextResponse.json({ prefs: normalise(data?.push_prefs) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/push/prefs
 *
 * Body: `{ prefs: { message_received?: boolean, ... } }`. Unknown keys
 * are dropped rather than stored, so a typo can't silently create a
 * preference nothing reads.
 */
export async function POST(request: Request) {
  try {
    const { supabase, userId } = await getCurrentAccount()

    const body = await request.json().catch(() => null)
    if (!body || typeof body.prefs !== 'object' || body.prefs === null) {
      return NextResponse.json({ error: 'prefs is required' }, { status: 400 })
    }

    const prefs = normalise(body.prefs)

    const { error } = await supabase
      .from('profiles')
      .update({ push_prefs: prefs })
      .eq('user_id', userId)

    if (error) {
      console.error('[push/prefs POST] update failed:', error)
      return NextResponse.json(
        { error: 'Failed to save notification preferences' },
        { status: 500 },
      )
    }

    return NextResponse.json({ prefs })
  } catch (err) {
    return toErrorResponse(err)
  }
}
