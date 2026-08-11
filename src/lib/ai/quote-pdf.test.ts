import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ReceiptExtraction } from './receipt'

const h = vi.hoisted(() => ({
  renderQuotePdf: vi.fn(),
  uploadServerMedia: vi.fn(),
  engineSendMedia: vi.fn(),
  upsertField: vi.fn(),
}))

vi.mock('@/lib/quotes/render', () => ({ renderQuotePdf: h.renderQuotePdf }))
vi.mock('@/lib/storage/upload-server', () => ({
  uploadServerMedia: h.uploadServerMedia,
}))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendMedia: h.engineSendMedia }))
vi.mock('./receipt', () => ({ upsertField: h.upsertField }))

import { sendQuoteProposal, PROPUESTA_FIELD_NAME } from './quote-pdf'

/**
 * Fake covering exactly what the module reads: the contact's name, and
 * the custom field holding the last delivered panel count.
 */
function fakeDb(seed: { name?: string | null; sentPanels?: string } = {}) {
  const db = {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => {
          if (table === 'contacts') {
            return Promise.resolve({
              data: { name: seed.name ?? null },
              error: null,
            })
          }
          if (table === 'custom_fields') {
            return Promise.resolve({
              data:
                seed.sentPanels === undefined ? null : { id: 'field-1' },
              error: null,
            })
          }
          // contact_custom_values
          return Promise.resolve({
            data:
              seed.sentPanels === undefined
                ? null
                : { value: seed.sentPanels },
            error: null,
          })
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return db
}

/** Osvaldo's receipt: 2,135 kWh -> 14 panels, $10,237.30 a bimester. */
function reading(overrides: Partial<ReceiptExtraction> = {}): ReceiptExtraction {
  return {
    consumo_periodo_actual_kwh: 2944,
    periodo_actual: '22 MAY 26 - 22 JUL 26',
    historial_bimestres_kwh: [2177, 1487, 1447, 1966, 2788],
    cantidad_periodos_usados: 6,
    promedio_bimestral_kwh: 2135,
    tarifa: '1D',
    ciudad: 'CANCUN, Q.R.',
    importe_periodo_mxn: 9814.27,
    importe_dap_mxn: 423.03,
    importe_total_a_pagar_mxn: 10237.85,
    historial_bimestres_importe_mxn: [6481, 5815, 5589, 7999, 9173],
    costo_periodo_mxn: 10237.3,
    advertencias: '',
    ...overrides,
  }
}

const ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
}

beforeEach(() => {
  h.renderQuotePdf.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    pageCount: 4,
  })
  h.uploadServerMedia.mockResolvedValue({
    publicUrl: 'https://storage.test/account-acct-1/1-propuesta.pdf',
    path: 'account-acct-1/1-propuesta.pdf',
  })
  h.engineSendMedia.mockResolvedValue({ whatsapp_message_id: 'wamid.1' })
  h.upsertField.mockResolvedValue(undefined)
})

describe('sendQuoteProposal — the happy path', () => {
  it('renders, uploads and sends a document named for the folio', async () => {
    const out = await sendQuoteProposal(fakeDb({ name: 'Osvaldo Coyac' }), {
      ...ARGS,
      extraction: reading(),
    })

    expect(out).toEqual({
      kind: 'sent',
      panels: 14,
      folio: expect.stringMatching(/^GE-\d{4}-[0-9A-Z]{4}$/),
    })

    const folio = out.kind === 'sent' ? out.folio : ''
    expect(h.engineSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'document',
        link: 'https://storage.test/account-acct-1/1-propuesta.pdf',
        filename: `Propuesta ${folio}.pdf`,
        aiGenerated: true,
      }),
    )
    // No caption — the bot's text reply already stated the numbers.
    expect(h.engineSendMedia.mock.calls[0][0].caption).toBeUndefined()
  })

  it('uploads as a PDF so Meta and the bucket both accept it', async () => {
    await sendQuoteProposal(fakeDb(), { ...ARGS, extraction: reading() })
    expect(h.uploadServerMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'chat-media',
        accountId: 'acct-1',
        contentType: 'application/pdf',
      }),
    )
  })

  it("draws the contact's name onto the cover", async () => {
    await sendQuoteProposal(fakeDb({ name: 'Osvaldo Coyac' }), {
      ...ARGS,
      extraction: reading(),
    })
    expect(h.renderQuotePdf.mock.calls[0][0]).toMatchObject({
      nombre: 'Osvaldo Coyac',
      paneles: '14',
      precio: '$ 127,000',
      gastoSinBimestre: '$ 10,237',
      ahorro25Anios: '$ 2,250,258',
    })
  })

  it('records the delivered tier, but only after the send lands', async () => {
    await sendQuoteProposal(fakeDb(), { ...ARGS, extraction: reading() })
    expect(h.upsertField).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        fieldName: PROPUESTA_FIELD_NAME,
        value: '14',
        overwrite: true,
      }),
    )
    expect(h.engineSendMedia.mock.invocationCallOrder[0]).toBeLessThan(
      h.upsertField.mock.invocationCallOrder[0],
    )
  })
})

describe('sendQuoteProposal — when it must not send', () => {
  const expectNothingSent = () => {
    expect(h.renderQuotePdf).not.toHaveBeenCalled()
    expect(h.engineSendMedia).not.toHaveBeenCalled()
    expect(h.upsertField).not.toHaveBeenCalled()
  }

  it('skips an unreadable consumption', async () => {
    const out = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading({ promedio_bimestral_kwh: null }),
    })
    expect(out).toEqual({ kind: 'skipped', reason: 'not_quotable' })
    expectNothingSent()
  })

  it('skips a single-period average — that is not an average', async () => {
    const out = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading({ cantidad_periodos_usados: 1 }),
    })
    expect(out).toEqual({ kind: 'skipped', reason: 'not_quotable' })
    expectNothingSent()
  })

  it('skips a consumption past the price table', async () => {
    const out = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading({ promedio_bimestral_kwh: 4000 }),
    })
    expect(out).toEqual({ kind: 'skipped', reason: 'not_quotable' })
    expectNothingSent()
  })

  it('skips when there is no peso amount — blank cards read as broken', async () => {
    const out = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading({ costo_periodo_mxn: null }),
    })
    expect(out).toEqual({ kind: 'skipped', reason: 'no_financials' })
    expectNothingSent()
  })

  it('skips a re-send that would land on the same tier', async () => {
    // Same tier means the same folio and the same numbers — a
    // byte-for-byte duplicate in the customer's chat.
    const out = await sendQuoteProposal(fakeDb({ sentPanels: '14' }), {
      ...ARGS,
      extraction: reading(),
    })
    expect(out).toEqual({ kind: 'skipped', reason: 'same_tier' })
    expectNothingSent()
  })

  it('DOES send when a new receipt moves the customer to another tier', async () => {
    // 1,400 kWh is the 10-panel tier; they were quoted 14 before.
    const out = await sendQuoteProposal(fakeDb({ sentPanels: '14' }), {
      ...ARGS,
      extraction: reading({
        promedio_bimestral_kwh: 1400,
        costo_periodo_mxn: 6500,
      }),
    })
    expect(out).toMatchObject({ kind: 'sent', panels: 10 })
    expect(h.engineSendMedia).toHaveBeenCalled()
  })
})

describe('sendQuoteProposal — failure is never the conversation’s problem', () => {
  it('returns failed instead of throwing when the render blows up', async () => {
    h.renderQuotePdf.mockRejectedValue(new Error('template missing'))
    const out = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading(),
    })
    expect(out).toEqual({ kind: 'failed', error: 'template missing' })
    expect(h.engineSendMedia).not.toHaveBeenCalled()
  })

  it('returns failed when storage rejects the upload', async () => {
    h.uploadServerMedia.mockRejectedValue(new Error('bucket full'))
    const out = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading(),
    })
    expect(out).toMatchObject({ kind: 'failed' })
    expect(h.engineSendMedia).not.toHaveBeenCalled()
  })

  it('leaves the tier unrecorded when the send fails, so it retries', async () => {
    h.engineSendMedia.mockRejectedValue(new Error('Meta 400'))
    const out = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading(),
    })
    expect(out).toMatchObject({ kind: 'failed' })
    expect(h.upsertField).not.toHaveBeenCalled()
  })
})
