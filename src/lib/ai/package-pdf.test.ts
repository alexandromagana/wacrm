import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  renderPackagePdf: vi.fn(),
  uploadServerMedia: vi.fn(),
  engineSendMedia: vi.fn(),
  upsertField: vi.fn(),
  applyQuoteSentTag: vi.fn(),
}))

vi.mock('@/lib/quotes/render', () => ({
  renderPackagePdf: h.renderPackagePdf,
  renderQuotePdf: vi.fn(),
}))
vi.mock('@/lib/storage/upload-server', () => ({
  uploadServerMedia: h.uploadServerMedia,
}))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendMedia: h.engineSendMedia }))
vi.mock('./receipt', () => ({
  upsertField: h.upsertField,
}))
vi.mock('./lead-status', () => ({ applyQuoteSentTag: h.applyQuoteSentTag }))

import {
  PAQUETE_FIELD_NAME,
  readSentPackagePanels,
  sendPackageSheet,
} from './package-pdf'
import { tierForPanels } from '@/lib/quotes/pricing'

/**
 * Fake covering what the module touches: custom fields by name (with a
 * value per contact), the contact's name, and the open deal the quote is
 * recorded on. `dealUpdates` collects what landed on the deal.
 */
function fakeDb(fields: Record<string, string> = {}) {
  const dealUpdates: Record<string, unknown>[] = []
  const db = {
    from: (table: string) => {
      if (table === 'deals') {
        const chain = {
          select: () => chain,
          update: (payload: Record<string, unknown>) => {
            dealUpdates.push(payload)
            return chain
          },
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: { id: 'deal-1' }, error: null }),
          then: (resolve: (v: { error: null }) => void) =>
            resolve({ error: null }),
        }
        return chain
      }

      // custom_fields keyed by `field_name`, contact_custom_values by the
      // field id — here the name doubles as the id.
      let key: string | null = null
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => {
          if (column === 'field_name' || column === 'custom_field_id') {
            key = value
          }
          return chain
        },
        maybeSingle: () => {
          if (table === 'contacts') {
            return Promise.resolve({ data: { name: 'Ana' }, error: null })
          }
          const present = key != null && key in fields
          if (table === 'custom_fields') {
            return Promise.resolve({
              data: present ? { id: key } : null,
              error: null,
            })
          }
          return Promise.resolve({
            data: present ? { value: fields[key!] } : null,
            error: null,
          })
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return Object.assign(db, { dealUpdates })
}

const ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
}
const TIER_12 = tierForPanels(12)!

beforeEach(() => {
  vi.clearAllMocks()
  h.renderPackagePdf.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    pageCount: 1,
  })
  h.uploadServerMedia.mockResolvedValue({
    publicUrl: 'https://cdn.test/cotizacion.pdf',
    path: 'account-acct-1/cotizacion.pdf',
  })
  h.engineSendMedia.mockResolvedValue({ whatsapp_message_id: 'wamid-1' })
  h.upsertField.mockResolvedValue(undefined)
  h.applyQuoteSentTag.mockResolvedValue(undefined)
})

describe('sendPackageSheet', () => {
  it('renders, sends and records the package as a quote', async () => {
    const db = fakeDb()
    const outcome = await sendPackageSheet(db, { ...ARGS, tier: TIER_12 })

    expect(outcome).toMatchObject({ kind: 'sent', panels: 12 })
    expect(h.renderPackagePdf.mock.calls[0][0]).toMatchObject({
      paneles: '12',
      precio: '$ 106,900',
    })
    expect(h.engineSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'document',
        link: 'https://cdn.test/cotizacion.pdf',
        filename: expect.stringMatching(/^Cotización GE-\d{4}-\w{4}\.pdf$/),
      }),
    )
    expect(h.upsertField).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ fieldName: PAQUETE_FIELD_NAME, value: '12' }),
    )
    expect(db.dealUpdates).toEqual([
      {
        value: 106_900,
        panel_count: 12,
        quote_url: 'https://cdn.test/cotizacion.pdf',
      },
    ])
    expect(h.applyQuoteSentTag).toHaveBeenCalledTimes(1)
  })

  it('records nothing until the document is actually sent', async () => {
    h.engineSendMedia.mockRejectedValue(new Error('Meta 500'))
    const db = fakeDb()
    const outcome = await sendPackageSheet(db, { ...ARGS, tier: TIER_12 })

    expect(outcome).toEqual({ kind: 'failed', error: 'Meta 500' })
    expect(h.upsertField).not.toHaveBeenCalled()
    expect(db.dealUpdates).toEqual([])
    expect(h.applyQuoteSentTag).not.toHaveBeenCalled()
  })

  it('never throws when the template fails to render', async () => {
    h.renderPackagePdf.mockRejectedValue(new Error('template missing'))
    const outcome = await sendPackageSheet(fakeDb(), { ...ARGS, tier: TIER_12 })

    expect(outcome).toEqual({ kind: 'failed', error: 'template missing' })
    expect(h.engineSendMedia).not.toHaveBeenCalled()
  })
})

describe('readSentPackagePanels', () => {
  it('is null for a contact who never got a sheet', async () => {
    expect(await readSentPackagePanels(fakeDb(), ARGS)).toBeNull()
  })

  it('returns the package whose sheet went out', async () => {
    const db = fakeDb({ [PAQUETE_FIELD_NAME]: '12' })
    expect(await readSentPackagePanels(db, ARGS)).toBe(12)
  })
})
