import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ReceiptExtraction } from './receipt'

const h = vi.hoisted(() => ({
  renderQuotePdf: vi.fn(),
  uploadServerMedia: vi.fn(),
  engineSendMedia: vi.fn(),
  upsertField: vi.fn(),
  applyQuoteSentTag: vi.fn(),
}))

vi.mock('@/lib/quotes/render', () => ({ renderQuotePdf: h.renderQuotePdf }))
vi.mock('@/lib/storage/upload-server', () => ({
  uploadServerMedia: h.uploadServerMedia,
}))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendMedia: h.engineSendMedia }))
vi.mock('./receipt', () => ({ upsertField: h.upsertField }))
vi.mock('./lead-status', () => ({ applyQuoteSentTag: h.applyQuoteSentTag }))

import { sendQuoteProposal, PROPUESTA_FIELD_NAME } from './quote-pdf'

interface Seed {
  name?: string | null
  sentPanels?: string
  /** The contact's newest open deal; null means they have none. */
  openDeal?: { id: string } | null
}

/**
 * Fake covering what the module touches: the contact's name, the custom
 * field holding the last delivered panel count, and the contact's open
 * deal (looked up, then updated with the quoted figures).
 *
 * `dealUpdates` collects the update payloads so a test can assert what
 * landed on the deal without a real database.
 */
function fakeDb(seed: Seed = {}) {
  const dealUpdates: Record<string, unknown>[] = []
  const openDeal = seed.openDeal === undefined ? { id: 'deal-1' } : seed.openDeal

  const db = {
    from: (table: string) => {
      if (table === 'deals') {
        // Thenable: the update path is awaited on the trailing .eq(),
        // while the select path resolves through maybeSingle().
        const chain = {
          select: () => chain,
          update: (payload: Record<string, unknown>) => {
            dealUpdates.push(payload)
            return chain
          },
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: openDeal, error: null }),
          then: (resolve: (v: { error: null }) => void) =>
            resolve({ error: null }),
        }
        return chain
      }

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

  return Object.assign(db, { dealUpdates })
}

/** Osvaldo's receipt: 2,135 kWh -> 14 panels, $10,237.30 a bimester. */
function reading(overrides: Partial<ReceiptExtraction> = {}): ReceiptExtraction {
  return {
    consumo_periodo_actual_kwh: 2944,
    periodo_actual: '22 MAY 26 - 22 JUL 26',
    historial_bimestres_kwh: [2177, 1487, 1447, 1966, 2788],
    cantidad_periodos_usados: 6,
    promedio_bimestral_kwh: 2135,
    incluye_periodo_actual: true,
    periodos_promediados_kwh: [2944, 2177, 1487, 1447, 1966, 2788],
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
  h.applyQuoteSentTag.mockResolvedValue(undefined)
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

  it('gives two different systems two different folios', async () => {
    // The bug this closes: the same contact received a 6-panel and a
    // 4-panel proposal, both stamped GE-2026-KEYH. Sales reads the folio
    // back over the phone; it has to identify one document.
    const catorce = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading(),
    })
    const ocho = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading({
        promedio_bimestral_kwh: 1220,
        periodos_promediados_kwh: [1300, 1250, 1200, 1150, 1220, 1200],
      }),
    })

    expect(catorce.kind).toBe('sent')
    expect(ocho.kind).toBe('sent')
    if (catorce.kind !== 'sent' || ocho.kind !== 'sent') return
    expect(ocho.panels).toBe(8)
    expect(ocho.folio).not.toBe(catorce.folio)
  })

  it('reproduces the folio when the same system is re-sent', async () => {
    // The property that made seeding on the contact worth doing in the
    // first place, and that the fix must not cost.
    const primera = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading(),
    })
    const repetida = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading(),
    })
    expect(primera).toEqual(repetida)
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

describe('sendQuoteProposal — what the sale sees afterwards', () => {
  it('carries the quoted figures onto the open deal', async () => {
    // The board used to show a $0 card next to a $127,000 proposal,
    // because nothing wrote the numbers back out of the PDF.
    const db = fakeDb()
    await sendQuoteProposal(db, { ...ARGS, extraction: reading() })

    expect(db.dealUpdates).toEqual([
      {
        value: 127_000,
        panel_count: 14,
        quote_url: 'https://storage.test/account-acct-1/1-propuesta.pdf',
      },
    ])
  })

  it('tags "Quote sent" once the document is genuinely delivered', async () => {
    await sendQuoteProposal(fakeDb(), { ...ARGS, extraction: reading() })
    expect(h.applyQuoteSentTag).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId: 'acct-1', contactId: 'contact-1' }),
    )
  })

  it('fills the deal BEFORE tagging, so the moved card is already correct', async () => {
    // Tagging fires the "Quote sent -> Proposal Sent" automation, which
    // moves this same deal. Writing the figures first means the card
    // never shows up in the new stage with stale numbers on it.
    const db = fakeDb()
    await sendQuoteProposal(db, { ...ARGS, extraction: reading() })
    expect(db.dealUpdates).toHaveLength(1)
    expect(h.applyQuoteSentTag).toHaveBeenCalled()
  })

  it('still sends and tags when the contact has no open deal', async () => {
    // A contact quoted before the pipeline automation existed has
    // nothing to update — that is a no-op, not a failed quote.
    const db = fakeDb({ openDeal: null })
    const out = await sendQuoteProposal(db, { ...ARGS, extraction: reading() })

    expect(out).toMatchObject({ kind: 'sent', panels: 14 })
    expect(db.dealUpdates).toEqual([])
    expect(h.applyQuoteSentTag).toHaveBeenCalled()
  })
})

describe('sendQuoteProposal — when it must not send', () => {
  const expectNothingSent = () => {
    expect(h.renderQuotePdf).not.toHaveBeenCalled()
    expect(h.engineSendMedia).not.toHaveBeenCalled()
    expect(h.upsertField).not.toHaveBeenCalled()
    // No document, no tag — otherwise the 48h follow-up would start
    // counting against a proposal the customer never received.
    expect(h.applyQuoteSentTag).not.toHaveBeenCalled()
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

  it('holds the document when the history hides an empty house', async () => {
    // Fabiola's real reading. It prices at 8 panels and the bot has been
    // told to ask why one bimester reads 216 kWh — the document waits
    // for the answer instead of arriving alongside the question.
    const out = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading({
        consumo_periodo_actual_kwh: 2545,
        historial_bimestres_kwh: [1126, 879, 1067, 1485, 216],
        promedio_bimestral_kwh: 1220,
        periodos_promediados_kwh: [2545, 1126, 879, 1067, 1485, 216],
      }),
    })
    expect(out).toEqual({ kind: 'skipped', reason: 'needs_review' })
    expectNothingSent()
  })

  it('holds the document when page 1 never got read', async () => {
    const out = await sendQuoteProposal(fakeDb(), {
      ...ARGS,
      extraction: reading({
        consumo_periodo_actual_kwh: null,
        incluye_periodo_actual: false,
        cantidad_periodos_usados: 5,
        promedio_bimestral_kwh: 2113,
        periodos_promediados_kwh: [2177, 1487, 1447, 1966, 2788],
      }),
    })
    expect(out).toEqual({ kind: 'skipped', reason: 'needs_review' })
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
    // Nothing reached the customer, so the follow-up clock must not start.
    expect(h.applyQuoteSentTag).not.toHaveBeenCalled()
  })
})
