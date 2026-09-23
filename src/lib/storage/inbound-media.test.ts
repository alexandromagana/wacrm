import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: h.getMediaUrl,
  downloadMedia: h.downloadMedia,
}))

import {
  INBOUND_MEDIA_BUCKET,
  archiveInboundMedia,
  fetchInboundMediaFromMeta,
  inboundMediaPath,
  isValidMediaId,
  readInboundMedia,
  storeInboundMedia,
} from './inbound-media'

const ACCOUNT = '11111111-2222-3333-4444-555555555555'
const MEDIA_ID = '1037543291543636'

/** Storage client stub: records what reached the bucket. */
function makeDb(opts: {
  uploadError?: string
  download?: { data: Blob | null; error: { message: string } | null }
} = {}) {
  const upload = vi.fn(async () => ({
    data: opts.uploadError ? null : { path: 'x' },
    error: opts.uploadError ? { message: opts.uploadError } : null,
  }))
  const download = vi.fn(async () => opts.download ?? { data: null, error: null })
  const from = vi.fn(() => ({ upload, download }))
  const db = { storage: { from } } as unknown as SupabaseClient
  return { db, from, upload, download }
}

beforeEach(() => {
  h.getMediaUrl.mockResolvedValue({
    url: 'https://lookaside.test/media',
    mimeType: 'application/pdf',
  })
  h.downloadMedia.mockResolvedValue({
    buffer: Buffer.from('%PDF-1.7'),
    contentType: 'application/pdf',
  })
})

describe('inboundMediaPath', () => {
  it('namespaces under account-<id> so the read policy matches', () => {
    expect(inboundMediaPath(ACCOUNT, MEDIA_ID)).toBe(
      `account-${ACCOUNT}/${MEDIA_ID}`,
    )
  })

  it('refuses an id that could climb out of the account folder', () => {
    for (const bad of ['', '../account-other/1', 'a/b', 'a.b', 'x'.repeat(129)]) {
      expect(isValidMediaId(bad)).toBe(false)
      expect(() => inboundMediaPath(ACCOUNT, bad)).toThrow(/Invalid WhatsApp media id/)
    }
  })
})

describe('storeInboundMedia', () => {
  it('upserts into the private bucket with the given type', async () => {
    const { db, from, upload } = makeDb()
    const bytes = Buffer.from('%PDF-1.7')

    await storeInboundMedia({
      db,
      accountId: ACCOUNT,
      mediaId: MEDIA_ID,
      bytes,
      contentType: 'application/pdf',
    })

    expect(from).toHaveBeenCalledWith(INBOUND_MEDIA_BUCKET)
    expect(upload).toHaveBeenCalledWith(`account-${ACCOUNT}/${MEDIA_ID}`, bytes, {
      contentType: 'application/pdf',
      upsert: true,
      cacheControl: '31536000',
    })
  })

  it('throws when storage rejects the upload', async () => {
    const { db } = makeDb({ uploadError: 'Payload too large' })
    await expect(
      storeInboundMedia({
        db,
        accountId: ACCOUNT,
        mediaId: MEDIA_ID,
        bytes: Buffer.from('x'),
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow(/Payload too large/)
  })
})

describe('fetchInboundMediaFromMeta', () => {
  it('keeps the sniffed type when the bytes were recognised', async () => {
    const result = await fetchInboundMediaFromMeta({
      mediaId: MEDIA_ID,
      accessToken: 'tok',
    })
    expect(result.contentType).toBe('application/pdf')
    expect(h.downloadMedia).toHaveBeenCalledWith({
      downloadUrl: 'https://lookaside.test/media',
      accessToken: 'tok',
    })
  })

  it("prefers Meta's recorded type over the CDN's bare octet-stream", async () => {
    h.getMediaUrl.mockResolvedValue({
      url: 'https://lookaside.test/media',
      mimeType: 'audio/ogg',
    })
    h.downloadMedia.mockResolvedValue({
      buffer: Buffer.from('OggS'),
      contentType: 'application/octet-stream',
    })

    const result = await fetchInboundMediaFromMeta({
      mediaId: MEDIA_ID,
      accessToken: 'tok',
    })
    expect(result.contentType).toBe('audio/ogg')
  })
})

describe('archiveInboundMedia', () => {
  it('copies the file from Meta into the bucket', async () => {
    const { db, upload } = makeDb()

    const ok = await archiveInboundMedia({
      db,
      accountId: ACCOUNT,
      mediaId: MEDIA_ID,
      accessToken: 'tok',
    })

    expect(ok).toBe(true)
    expect(h.getMediaUrl).toHaveBeenCalledWith({ mediaId: MEDIA_ID, accessToken: 'tok' })
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('never throws when Meta no longer has the file', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.getMediaUrl.mockRejectedValue(
      new Error("(#100) Object with ID '1037543291543636' does not exist"),
    )
    const { db, upload } = makeDb()

    const ok = await archiveInboundMedia({
      db,
      accountId: ACCOUNT,
      mediaId: MEDIA_ID,
      accessToken: 'tok',
    })

    expect(ok).toBe(false)
    expect(upload).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('never throws when storage rejects the copy', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = makeDb({ uploadError: 'Bucket not found' })

    const ok = await archiveInboundMedia({
      db,
      accountId: ACCOUNT,
      mediaId: MEDIA_ID,
      accessToken: 'tok',
    })

    expect(ok).toBe(false)
    error.mockRestore()
  })
})

describe('readInboundMedia', () => {
  it('returns the stored copy', async () => {
    const blob = new Blob(['%PDF-1.7'], { type: 'application/pdf' })
    const { db, download } = makeDb({ download: { data: blob, error: null } })

    const result = await readInboundMedia({ db, accountId: ACCOUNT, mediaId: MEDIA_ID })

    expect(result).toBe(blob)
    expect(download).toHaveBeenCalledWith(`account-${ACCOUNT}/${MEDIA_ID}`)
  })

  it('returns null when there is no copy', async () => {
    const { db } = makeDb({
      download: { data: null, error: { message: 'Object not found' } },
    })

    expect(
      await readInboundMedia({ db, accountId: ACCOUNT, mediaId: MEDIA_ID }),
    ).toBeNull()
  })
})
