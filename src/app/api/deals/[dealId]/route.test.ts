import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  afterCallbacks: [] as Array<() => Promise<void>>,
  before: { id: 'deal-1', stage_id: 'stage-visit', status: 'open', contact_id: 'contact-1' } as Record<
    string,
    unknown
  >,
  /** What the update returns — the row as the DB trigger left it. */
  updated: { stage_id: 'stage-signed', status: 'won', closed_at: '2026-09-23T17:00:00Z' } as Record<
    string,
    unknown
  >,
  updates: [] as Array<Record<string, unknown>>,
}))

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: (fn: () => Promise<void>) => h.afterCallbacks.push(fn) }
})
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: h.runAutomationsForTrigger }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { send: {} },
}))

function builder(table: string) {
  let op: 'select' | 'update' = 'select'
  const b: Record<string, unknown> = {
    select: () => b,
    eq: () => b,
    update: (payload: Record<string, unknown>) => {
      op = 'update'
      h.updates.push(payload)
      return b
    },
    maybeSingle: () =>
      Promise.resolve({ data: table === 'deals' ? h.before : { id: 'stage-signed' }, error: null }),
    single: () => Promise.resolve({ data: op === 'update' ? h.updated : null, error: null }),
  }
  return b
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    supabase: { from: builder },
    accountId: 'acct-1',
    userId: 'user-1',
  }),
  toErrorResponse: (err: unknown) => new Response(String(err), { status: 500 }),
}))

import { PATCH } from './route'

async function patch(body: Record<string, unknown>) {
  const res = await PATCH(
    new Request('http://test/api/deals/deal-1', { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ dealId: 'deal-1' }) },
  )
  for (const fn of h.afterCallbacks.splice(0)) await fn()
  return res
}

const firedTriggers = () => h.runAutomationsForTrigger.mock.calls.map((c) => c[0].triggerType)

beforeEach(() => {
  h.runAutomationsForTrigger.mockReset()
  h.afterCallbacks.length = 0
  h.updates.length = 0
  h.before = { id: 'deal-1', stage_id: 'stage-visit', status: 'open', contact_id: 'contact-1' }
  h.updated = { stage_id: 'stage-signed', status: 'won', closed_at: '2026-09-23T17:00:00Z' }
})

describe('PATCH /api/deals/[dealId]', () => {
  it('fires deal_won when a drag onto the won stage made the trigger win the deal', async () => {
    const res = await patch({ stage_id: 'stage-signed' })

    expect(res.status).toBe(200)
    expect(firedTriggers()).toEqual(['deal_stage_changed', 'deal_won'])
    // The board merges this instead of reloading.
    expect(await res.json()).toMatchObject({ deal: { status: 'won', stage_id: 'stage-signed' } })
  })

  it('fires deal_stage_changed when the Won button moved the card', async () => {
    await patch({ status: 'won' })
    expect(firedTriggers()).toEqual(['deal_stage_changed', 'deal_won'])
  })

  it('fires nothing when nothing actually changed', async () => {
    h.updated = { stage_id: 'stage-visit', status: 'open', closed_at: null }
    await patch({ title: 'Renamed' })
    expect(firedTriggers()).toEqual([])
  })

  it('stores a lost reason with a lost status', async () => {
    h.updated = { stage_id: 'stage-visit', status: 'lost', closed_at: '2026-09-23T17:00:00Z' }
    await patch({ status: 'lost', lost_reason: 'precio' })
    expect(h.updates[0]).toEqual({ status: 'lost', lost_reason: 'precio' })
    expect(firedTriggers()).toEqual(['deal_lost'])
  })

  it('refuses a manual reason that would pass for an automatic one', async () => {
    const res = await patch({ status: 'lost', lost_reason: 'auto_sin_recibo' })
    expect(res.status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })
})
