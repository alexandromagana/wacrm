import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_type: 'text', content_text: 'third' },
      { sender_type: 'agent', content_type: 'text', content_text: 'second' },
      { sender_type: 'customer', content_type: 'text', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'bot', content_type: 'text', content_text: 'auto reply' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only text messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_type: 'text', content_text: '   ' },
        { sender_type: 'customer', content_type: 'text', content_text: null },
        { sender_type: 'customer', content_type: 'text', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('renders media messages as visible placeholders, not silence', async () => {
    // The regression this guards: the bot denying it received a receipt
    // because document/image rows were filtered out of its context.
    const rows = [
      { sender_type: 'customer', content_type: 'text', content_text: 'ya te mandé mi recibo' },
      { sender_type: 'customer', content_type: 'document', content_text: 'recibo_cfe.pdf' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: '[Documento adjunto: recibo_cfe.pdf]' },
      { role: 'user', content: 'ya te mandé mi recibo' },
    ])
  })

  it('covers image, audio, video, and location placeholders', async () => {
    const rows = [
      { sender_type: 'customer', content_type: 'location', content_text: null },
      { sender_type: 'customer', content_type: 'video', content_text: null },
      { sender_type: 'customer', content_type: 'audio', content_text: null },
      { sender_type: 'customer', content_type: 'image', content_text: 'mi recibo' },
      { sender_type: 'customer', content_type: 'image', content_text: null },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out.map((m) => m.content)).toEqual([
      '[Imagen adjunta]',
      '[Imagen adjunta: mi recibo]',
      '[Nota de voz — sin transcripción disponible]',
      '[Video adjunto]',
      '[Ubicación compartida]',
    ])
  })

  it('passes template/interactive text through and drops textless ones', async () => {
    const rows = [
      { sender_type: 'customer', content_type: 'interactive', content_text: 'Sí, sigo interesado' },
      { sender_type: 'bot', content_type: 'template', content_text: null },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'Sí, sigo interesado' },
    ])
  })
})
