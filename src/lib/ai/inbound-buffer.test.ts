import { describe, it, expect, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  inboundDebounceMs,
  markReceiptMediaRead,
  resolveInboundBurst,
} from './inbound-buffer'

/** What each query chain recorded about itself, for the assertions that
 *  care WHICH rows a lookup asked for and not just what came back. */
interface Recorded {
  /** `eq` / `is` filters, as `column=value` pairs. */
  filters: string[]
}

/**
 * Fake matching the three query chains in resolveInboundBurst. The
 * newest-message query selects 'message_id' and ends in maybeSingle();
 * the media query selects 'media_url, created_at' and is awaited
 * directly (then); the human-took-it-over probe selects 'id' and ends in
 * maybeSingle(). The two maybeSingle chains are told apart by the
 * columns they asked for.
 */
function fakeDb(args: {
  newest: { message_id: string } | null
  media: { media_url: string | null; created_at: string }[]
  /** A HUMAN agent message exists after the freshest media. */
  answered?: boolean
  /** Receives what the media and probe chains filtered on. */
  seen?: { media?: Recorded; probe?: Recorded }
}): SupabaseClient {
  const make = () => {
    const selected = { current: '' }
    const rec: Recorded = { filters: [] }
    const chain: Record<string, unknown> = {
      select: (cols: string) => {
        selected.current = cols
        if (args.seen) {
          if (cols.includes('media_url')) args.seen.media = rec
          else if (cols.trim() === 'id') args.seen.probe = rec
        }
        return chain
      },
      eq: (col: string, val: unknown) => (
        rec.filters.push(`${col}=${String(val)}`), chain
      ),
      is: (col: string, val: unknown) => (
        rec.filters.push(`${col}=${String(val)}`), chain
      ),
      in: () => chain,
      gte: () => chain,
      gt: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () =>
        Promise.resolve(
          selected.current.includes('message_id')
            ? { data: args.newest, error: null }
            : { data: args.answered ? { id: 'msg-1' } : null, error: null },
        ),
      then: (
        onF: (v: unknown) => unknown,
        onR?: (e: unknown) => unknown,
      ) =>
        Promise.resolve({
          data: selected.current.includes('media_url') ? args.media : null,
          error: null,
        }).then(onF, onR),
    }
    return chain
  }
  return {
    from: () => make(),
  } as unknown as SupabaseClient
}

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString()

describe('inboundDebounceMs', () => {
  afterEach(() => delete process.env.AI_REPLY_DEBOUNCE_MS)

  it('defaults to 20s and honours the env override (including 0)', () => {
    expect(inboundDebounceMs()).toBe(20000)
    process.env.AI_REPLY_DEBOUNCE_MS = '15000'
    expect(inboundDebounceMs()).toBe(15000)
    process.env.AI_REPLY_DEBOUNCE_MS = '0'
    expect(inboundDebounceMs()).toBe(0)
  })
})

describe('resolveInboundBurst', () => {
  it('lets the newest delivery through with no media', async () => {
    const out = await resolveInboundBurst(
      fakeDb({ newest: { message_id: 'wamid.A' }, media: [] }),
      { conversationId: 'c1', metaMessageId: 'wamid.A' },
    )
    expect(out).toEqual({ superseded: false, receiptMediaIds: [] })
  })

  it('stands a superseded delivery down', async () => {
    const out = await resolveInboundBurst(
      fakeDb({ newest: { message_id: 'wamid.NEWER' }, media: [] }),
      { conversationId: 'c1', metaMessageId: 'wamid.A' },
    )
    expect(out.superseded).toBe(true)
  })

  it('collects fresh burst media oldest-first (page 1 before page 2)', async () => {
    const out = await resolveInboundBurst(
      fakeDb({
        newest: { message_id: 'wamid.A' },
        media: [
          { media_url: '/api/whatsapp/media/pag2', created_at: secondsAgo(5) },
          { media_url: '/api/whatsapp/media/pag1', created_at: secondsAgo(10) },
        ],
      }),
      { conversationId: 'c1', metaMessageId: 'wamid.A' },
    )
    expect(out).toEqual({
      superseded: false,
      receiptMediaIds: ['pag1', 'pag2'],
    })
  })

  it('ignores stale media — a later text must not re-extract an old receipt', async () => {
    const out = await resolveInboundBurst(
      fakeDb({
        newest: { message_id: 'wamid.A' },
        media: [
          {
            media_url: '/api/whatsapp/media/viejo',
            created_at: secondsAgo(5 * 60),
          },
        ],
      }),
      { conversationId: 'c1', metaMessageId: 'wamid.A' },
    )
    expect(out.receiptMediaIds).toEqual([])
  })

  it('does not re-read a receipt a human agent has already taken over', async () => {
    // An agent picked the thread up in the 90s after the bill landed.
    // Re-reading it here would auto-send a proposal underneath what
    // they are typing, which is the one thing a takeover must prevent.
    const out = await resolveInboundBurst(
      fakeDb({
        newest: { message_id: 'wamid.FINANCING' },
        media: [
          { media_url: '/api/whatsapp/media/recibo', created_at: secondsAgo(60) },
        ],
        answered: true,
      }),
      { conversationId: 'c1', metaMessageId: 'wamid.FINANCING' },
    )
    expect(out.receiptMediaIds).toEqual([])
  })

  it('still reads a brand-new receipt sent after an earlier reply', async () => {
    // The mirror case: `answered` is false because the probe only counts
    // messages NEWER than the freshest media. A customer who sends a
    // corrected bill must still get it read.
    const out = await resolveInboundBurst(
      fakeDb({
        newest: { message_id: 'wamid.B' },
        media: [
          { media_url: '/api/whatsapp/media/nuevo', created_at: secondsAgo(5) },
        ],
        answered: false,
      }),
      { conversationId: 'c1', metaMessageId: 'wamid.B' },
    )
    expect(out.receiptMediaIds).toEqual(['nuevo'])
  })

  it('includes an older page when the burst has one fresh page', async () => {
    // Page 1 sent 3 minutes ago, page 2 just now: fresh page 2 pulls
    // page 1 back into the same vision call.
    const out = await resolveInboundBurst(
      fakeDb({
        newest: { message_id: 'wamid.A' },
        media: [
          { media_url: '/api/whatsapp/media/pag2', created_at: secondsAgo(8) },
          {
            media_url: '/api/whatsapp/media/pag1',
            created_at: secondsAgo(3 * 60),
          },
        ],
      }),
      { conversationId: 'c1', metaMessageId: 'wamid.A' },
    )
    expect(out.receiptMediaIds).toEqual(['pag1', 'pag2'])
  })

  it('hands over a receipt the bot replied past without reading', async () => {
    // The regression this file exists for. The customer typed "Ok",
    // took twelve seconds to attach their CFE bill, and the reply to
    // the "Ok" landed after the PDF row. Counting any bot message as
    // proof the bill was handled locked it out of every turn that
    // followed: no quote went out and nothing said why. Only a human
    // message stops the read now — being unread is what makes media
    // eligible, and the query enforces it.
    const seen: { media?: Recorded; probe?: Recorded } = {}
    const out = await resolveInboundBurst(
      fakeDb({
        newest: { message_id: 'wamid.INSISTE' },
        media: [
          { media_url: '/api/whatsapp/media/recibo', created_at: secondsAgo(20) },
        ],
        answered: false,
        seen,
      }),
      { conversationId: 'c1', metaMessageId: 'wamid.INSISTE' },
    )
    expect(out.receiptMediaIds).toEqual(['recibo'])
    // Unread media only...
    expect(seen.media?.filters).toContain('ai_receipt_read_at=null')
    // ...and the takeover probe asks about humans, not the bot.
    expect(seen.probe?.filters).toContain('sender_type=agent')
    expect(seen.probe?.filters).not.toContain('sender_type=bot')
  })
})

describe('markReceiptMediaRead', () => {
  function fakeUpdateDb(sink: {
    patch?: Record<string, unknown>
    urls?: string[]
    conversationId?: string
  }): SupabaseClient {
    const chain: Record<string, unknown> = {
      update: (patch: Record<string, unknown>) => ((sink.patch = patch), chain),
      eq: (_col: string, val: string) => ((sink.conversationId = val), chain),
      in: (_col: string, vals: string[]) => {
        sink.urls = vals
        return Promise.resolve({ error: null })
      },
    }
    return { from: () => chain } as unknown as SupabaseClient
  }

  it('stamps exactly the media rows the turn looked at', async () => {
    const sink: {
      patch?: Record<string, unknown>
      urls?: string[]
      conversationId?: string
    } = {}
    await markReceiptMediaRead(fakeUpdateDb(sink), {
      conversationId: 'c1',
      mediaIds: ['pag1', 'pag2'],
    })
    expect(sink.conversationId).toBe('c1')
    expect(sink.urls).toEqual([
      '/api/whatsapp/media/pag1',
      '/api/whatsapp/media/pag2',
    ])
    expect(typeof sink.patch?.ai_receipt_read_at).toBe('string')
  })

  it('writes nothing when the turn read nothing', async () => {
    const sink: { patch?: Record<string, unknown> } = {}
    await markReceiptMediaRead(fakeUpdateDb(sink), {
      conversationId: 'c1',
      mediaIds: [],
    })
    expect(sink.patch).toBeUndefined()
  })

  it('swallows a write failure rather than costing the reply', async () => {
    const db = {
      from: () => ({
        update: () => ({
          eq: () => ({ in: () => Promise.reject(new Error('boom')) }),
        }),
      }),
    } as unknown as SupabaseClient
    await expect(
      markReceiptMediaRead(db, { conversationId: 'c1', mediaIds: ['x'] }),
    ).resolves.toBeUndefined()
  })
})
