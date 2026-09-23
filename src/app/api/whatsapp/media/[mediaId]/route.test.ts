import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// The media proxy serves our archived copy of a customer's file first and
// only asks Meta — which deletes inbound media after 7 days — when there
// is no copy yet, keeping what Meta returns so the next view is ours.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  configLoads: 0,
  readInboundMedia: vi.fn(),
  storeInboundMedia: vi.fn(),
  fetchInboundMediaFromMeta: vi.fn(),
  after: vi.fn(),
}))

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: h.after,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: h.user }, error: null }),
    },
    from: (table: string) => {
      if (table === 'whatsapp_config') h.configLoads++
      const result =
        table === 'profiles'
          ? { data: { account_id: 'acct-1' }, error: null }
          : { data: { access_token: 'enc-token' }, error: null }
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => result,
        single: async () => result,
      }
      return chain
    },
  }),
}))

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ role: 'service' }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (value: string) => `decrypted:${value}`,
}))

vi.mock('@/lib/storage/inbound-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/inbound-media')>()),
  readInboundMedia: h.readInboundMedia,
  storeInboundMedia: h.storeInboundMedia,
  fetchInboundMediaFromMeta: h.fetchInboundMediaFromMeta,
}))

import { GET } from './route'

const MEDIA_ID = '1037543291543636'

function get(mediaId: string) {
  return GET(new Request(`http://localhost/api/whatsapp/media/${mediaId}`), {
    params: Promise.resolve({ mediaId }),
  })
}

beforeEach(() => {
  h.user = { id: 'user-1' }
  h.configLoads = 0
  h.readInboundMedia.mockResolvedValue(null)
  h.fetchInboundMediaFromMeta.mockResolvedValue({
    bytes: Buffer.from('%PDF-1.7'),
    contentType: 'application/pdf',
  })
  h.storeInboundMedia.mockResolvedValue(undefined)
})

describe('GET /api/whatsapp/media/[mediaId]', () => {
  it('serves the archived copy without asking Meta', async () => {
    h.readInboundMedia.mockResolvedValue(
      new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
    )

    const res = await get(MEDIA_ID)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Cache-Control')).toContain('private')
    expect(await res.text()).toBe('%PDF-1.7')
    expect(h.readInboundMedia).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', mediaId: MEDIA_ID }),
    )
    expect(h.fetchInboundMediaFromMeta).not.toHaveBeenCalled()
    // An archived file needs no WhatsApp token at all.
    expect(h.configLoads).toBe(0)
  })

  it('falls back to Meta and keeps a copy after responding', async () => {
    const res = await get(MEDIA_ID)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(await res.text()).toBe('%PDF-1.7')
    expect(h.fetchInboundMediaFromMeta).toHaveBeenCalledWith({
      mediaId: MEDIA_ID,
      accessToken: 'decrypted:enc-token',
    })

    // The copy is scheduled, not awaited by the response.
    expect(h.storeInboundMedia).not.toHaveBeenCalled()
    expect(h.after).toHaveBeenCalledTimes(1)
    await h.after.mock.calls[0][0]()
    expect(h.storeInboundMedia).toHaveBeenCalledWith({
      db: { role: 'service' },
      accountId: 'acct-1',
      mediaId: MEDIA_ID,
      bytes: Buffer.from('%PDF-1.7'),
      contentType: 'application/pdf',
    })
  })

  it('swallows a failed copy — the viewer already has the file', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.storeInboundMedia.mockRejectedValue(new Error('storage down'))

    const res = await get(MEDIA_ID)
    expect(res.status).toBe(200)
    await expect(h.after.mock.calls[0][0]()).resolves.toBeUndefined()
    error.mockRestore()
  })

  it('reports a file neither we nor Meta still have', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.fetchInboundMediaFromMeta.mockRejectedValue(
      new Error("(#100) Object with ID '1037543291543636' does not exist"),
    )

    const res = await get(MEDIA_ID)

    expect(res.status).toBe(500)
    expect(h.after).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('rejects an id that could escape the account folder', async () => {
    const res = await get('..')

    expect(res.status).toBe(400)
    expect(h.readInboundMedia).not.toHaveBeenCalled()
  })

  it('requires a signed-in user', async () => {
    h.user = null

    const res = await get(MEDIA_ID)

    expect(res.status).toBe(401)
    expect(h.readInboundMedia).not.toHaveBeenCalled()
  })
})
