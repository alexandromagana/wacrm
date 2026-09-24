import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ engineSendTemplate: vi.fn() }))

vi.mock('@/lib/automations/meta-send', () => ({ engineSendTemplate: h.engineSendTemplate }))
// engine.ts pulls in the admin client and the whole automation graph;
// only the pure name helper is needed here.
vi.mock('@/lib/automations/engine', () => ({
  firstNameOr: (name: string | null, fallback: string) =>
    (name ?? '').trim().split(/\s+/)[0] || fallback,
}))
vi.mock('@/lib/ai/lead-status', () => ({ QUOTE_SENT_TAG: { name: 'Quote sent' } }))

import { LIFECYCLE_CONFIG } from './config'
import { closeConversationWithDeal, executeDecision } from './execute'
import type { LifecycleSnapshot } from './rules'

interface Call {
  table: string
  op: 'select' | 'update' | 'delete' | 'insert' | null
  payload?: unknown
  filters: Array<[string, ...unknown[]]>
}

/**
 * Chainable fake: records every query, and resolves each one through
 * `respond`, which sees the table, the write, and the filters applied.
 */
function fakeDb(respond: (call: Call) => { data: unknown; error: unknown }) {
  const calls: Call[] = []
  const from = (table: string) => {
    const call: Call = { table, op: null, filters: [] }
    calls.push(call)
    const b: Record<string, unknown> = {}
    const filter =
      (name: string) =>
      (...args: unknown[]) => {
        call.filters.push([name, ...args])
        return b
      }
    for (const name of ['eq', 'neq', 'is', 'in', 'gte']) b[name] = filter(name)
    b.select = () => {
      call.op ??= 'select'
      return b
    }
    b.update = (payload: unknown) => {
      call.op = 'update'
      call.payload = payload
      return b
    }
    b.delete = () => {
      call.op = 'delete'
      return b
    }
    b.maybeSingle = () => Promise.resolve(respond(call))
    b.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(respond(call)).then(resolve, reject)
    return b
  }
  return { db: { from } as unknown as SupabaseClient, calls }
}

const SNAP: LifecycleSnapshot = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  contactName: 'Ana López',
  contactPhone: '+5215512345678',
  status: 'open',
  assignedAgentId: null,
  lastCustomerMessageAt: '2026-09-10T12:00:00.123456+00:00',
  conversationCreatedAt: '2026-09-01T12:00:00Z',
  closeSuggestedAt: null,
  closeSuggestionDismissedAt: null,
  exempt: false,
  deal: {
    id: 'deal-1',
    stageId: 'stage-new',
    stageName: 'New Lead',
    autoClose: true,
    isFirstStage: true,
    quotedAt: null,
    quoteUrl: null,
  },
  hasWonDeal: false,
  hasPendingAutomation: false,
  lastFollowUpAt: null,
  lastReminderAt: null,
  customerSentMedia: false,
}

beforeEach(() => {
  h.engineSendTemplate.mockReset()
})

describe('closing', () => {
  it('closes the chat, loses the deal and drops the Quote sent tag', async () => {
    const { db, calls } = fakeDb((call) => {
      if (call.table === 'tags') return { data: { id: 'tag-quote' }, error: null }
      if (call.op === 'update') return { data: [{ id: 'x' }], error: null }
      return { data: null, error: null }
    })

    const result = await executeDecision(
      db,
      SNAP,
      { action: 'close', reason: 'auto_sin_recibo', silentDays: 8 },
      LIFECYCLE_CONFIG,
      'user-1',
    )

    expect(result).toEqual({ outcome: 'done', detail: { deal_lost: true } })
    const [conv, deal, , tagDelete] = calls
    expect(conv).toMatchObject({
      table: 'conversations',
      op: 'update',
      payload: { status: 'closed', close_reason: 'auto_sin_recibo' },
    })
    // Compare-and-set on the customer's last message.
    expect(conv.filters).toContainEqual(['eq', 'last_customer_message_at', SNAP.lastCustomerMessageAt])
    expect(deal).toMatchObject({
      table: 'deals',
      op: 'update',
      payload: { status: 'lost', lost_reason: 'auto_sin_recibo' },
    })
    expect(deal.filters).toContainEqual(['eq', 'stage_id', 'stage-new'])
    expect(deal.filters).toContainEqual(['eq', 'status', 'open'])
    expect(tagDelete).toMatchObject({ table: 'contact_tags', op: 'delete' })
    expect(tagDelete.filters).toContainEqual(['eq', 'tag_id', 'tag-quote'])
  })

  it('touches nothing else when the customer wrote since the snapshot', async () => {
    const { db, calls } = fakeDb(() => ({ data: [], error: null }))

    const result = await executeDecision(
      db,
      SNAP,
      { action: 'close', reason: 'auto_sin_recibo', silentDays: 8 },
      LIFECYCLE_CONFIG,
      'user-1',
    )

    expect(result.outcome).toBe('skipped')
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('conversations')
  })

  it('matches a never-wrote contact on a null timestamp', async () => {
    const { db, calls } = fakeDb(() => ({ data: [], error: null }))
    await closeConversationWithDeal(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      reason: 'auto_sin_contacto',
      expectedLastCustomerMessageAt: null,
    })
    expect(calls[0].filters).toContainEqual(['is', 'last_customer_message_at', null])
  })

  it('skips the timestamp guard when a person closes by hand', async () => {
    const { db, calls } = fakeDb(() => ({ data: [], error: null }))
    await closeConversationWithDeal(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      reason: 'auto_sin_respuesta',
    })
    expect(calls[0].filters.some(([, column]) => column === 'last_customer_message_at')).toBe(false)
  })
})

describe('reminding', () => {
  it('sends the reminder template with the first name', async () => {
    h.engineSendTemplate.mockResolvedValue({ whatsapp_message_id: 'wamid.1' })
    const { db } = fakeDb(() => ({ data: null, error: null }))

    const result = await executeDecision(
      db,
      SNAP,
      { action: 'remind', reason: 'auto_sin_recibo', silentDays: 3 },
      LIFECYCLE_CONFIG,
      'user-1',
    )

    expect(result.outcome).toBe('done')
    expect(h.engineSendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'gama_seguimiento_lead',
        language: 'es_MX',
        params: ['Ana'],
        conversationId: 'conv-1',
      }),
    )
  })

  it('falls back to "cliente" for a nameless contact', async () => {
    h.engineSendTemplate.mockResolvedValue({ whatsapp_message_id: 'wamid.1' })
    const { db } = fakeDb(() => ({ data: null, error: null }))
    await executeDecision(
      db,
      { ...SNAP, contactName: null },
      { action: 'remind', reason: 'auto_sin_recibo', silentDays: 3 },
      LIFECYCLE_CONFIG,
      'user-1',
    )
    expect(h.engineSendTemplate.mock.calls[0][0].params).toEqual(['cliente'])
  })

  it('reports a failed send and closes nothing', async () => {
    h.engineSendTemplate.mockRejectedValue(new Error('131049 marketing limit'))
    const { db, calls } = fakeDb(() => ({ data: null, error: null }))

    const result = await executeDecision(
      db,
      SNAP,
      { action: 'remind', reason: 'auto_sin_recibo', silentDays: 3 },
      LIFECYCLE_CONFIG,
      'user-1',
    )

    expect(result).toEqual({ outcome: 'failed', detail: { error: '131049 marketing limit' } })
    expect(calls).toHaveLength(0)
  })
})

describe('suggesting', () => {
  it('flags the chat only if nobody flagged it yet', async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: 'conv-1' }], error: null }))

    const result = await executeDecision(
      db,
      { ...SNAP, assignedAgentId: 'agent-1' },
      { action: 'suggest', reason: 'auto_sin_recibo', silentDays: 9 },
      LIFECYCLE_CONFIG,
      'user-1',
    )

    expect(result.outcome).toBe('done')
    expect(calls[0]).toMatchObject({
      table: 'conversations',
      op: 'update',
      payload: expect.objectContaining({ close_suggested_reason: 'auto_sin_recibo' }),
    })
    expect(calls[0].filters).toContainEqual(['is', 'close_suggested_at', null])
  })
})
