import { describe, it, expect, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { inboundDebounceMs, resolveInboundBurst } from './inbound-buffer'

/**
 * Fake matching the three query chains in resolveInboundBurst. The
 * newest-message query selects 'message_id' and ends in maybeSingle();
 * the media query selects 'media_url, created_at' and is awaited
 * directly (then); the already-answered probe selects 'id' and ends in
 * maybeSingle(). The two maybeSingle chains are told apart by the
 * columns they asked for.
 */
function fakeDb(args: {
  newest: { message_id: string } | null
  media: { media_url: string | null; created_at: string }[]
  /** An outbound message exists after the freshest media. */
  answered?: boolean
}): SupabaseClient {
  const make = (selected: { current: string }) => {
    const chain: Record<string, unknown> = {
      select: (cols: string) => ((selected.current = cols), chain),
      eq: () => chain,
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
    from: () => make({ current: '' }),
  } as unknown as SupabaseClient
}

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString()

describe('inboundDebounceMs', () => {
  afterEach(() => delete process.env.AI_REPLY_DEBOUNCE_MS)

  it('defaults to 8s and honours the env override (including 0)', () => {
    expect(inboundDebounceMs()).toBe(8000)
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

  it('does not re-read a receipt the bot has already answered', async () => {
    // The regression: receipt at 15:23, bot replies, customer asks about
    // financing at 15:24. The media is still inside the 90s window, so
    // elapsed time alone would re-run the vision call — and the second
    // read priced the same roof differently, sending a second, cheaper,
    // wrong quote on top of the first.
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
    // outbound messages NEWER than the freshest media. A customer who
    // sends a corrected bill must still get it read.
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
})
