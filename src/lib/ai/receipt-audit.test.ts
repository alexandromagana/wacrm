import { describe, it, expect, vi, beforeEach } from 'vitest'

const insert = vi.fn()
const from = vi.fn(() => ({ insert }))
vi.mock('./admin-client', () => ({ supabaseAdmin: () => ({ from }) }))

const { logReceiptReading } = await import('./receipt-audit')
const { buildExtraction } = await import('./receipt')

beforeEach(() => {
  insert.mockReset().mockResolvedValue({ error: null })
  from.mockClear()
})

const base = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  source: 'auto_reply' as const,
  provider: 'anthropic' as const,
  model: 'claude-x',
}

describe('logReceiptReading', () => {
  it('keeps the raw response next to what the code made of it', async () => {
    // The pair is the whole point: `parsed` is the reading the quote was
    // built on, `raw_response` is what the model actually said, and a
    // future misread lives in the gap between them.
    const raw = '{"consumo_periodo_actual_kwh":1574}'
    const extraction = buildExtraction({
      consumo_periodo_actual_kwh: 1574,
      historial_bimestres_kwh: [1076, 446],
    })
    await logReceiptReading({
      ...base,
      rawResponse: raw,
      extraction,
      mediaIds: ['media-a', 'media-b'],
    })

    expect(from).toHaveBeenCalledWith('ai_receipt_readings')
    const row = insert.mock.calls[0][0]
    expect(row.account_id).toBe('acct-1')
    expect(row.conversation_id).toBe('conv-1')
    expect(row.contact_id).toBe('contact-1')
    expect(row.source).toBe('auto_reply')
    expect(row.provider).toBe('anthropic')
    expect(row.model).toBe('claude-x')
    expect(row.raw_response).toBe(raw)
    expect(row.parsed).toBe(extraction)
    expect(row.media_ids).toEqual(['media-a', 'media-b'])
  })

  it('lifts the average out so an audit can scan for it', async () => {
    const extraction = buildExtraction({
      consumo_periodo_actual_kwh: 1574,
      historial_bimestres_kwh: [1076, 446, 459, 643, 984],
    })
    await logReceiptReading({ ...base, rawResponse: '{}', extraction })
    expect(insert.mock.calls[0][0].promedio_kwh).toBe(864)
  })

  it('still records a response that would not parse', async () => {
    // The case most worth having afterwards. This used to leave nothing
    // behind at all, because the extraction returned null and the raw
    // string went out of scope with the request.
    await logReceiptReading({
      ...base,
      rawResponse: 'Lo siento, no puedo leer esta imagen.',
      extraction: null,
    })
    const row = insert.mock.calls[0][0]
    expect(row.raw_response).toBe('Lo siento, no puedo leer esta imagen.')
    expect(row.parsed).toBeNull()
    expect(row.promedio_kwh).toBeNull()
  })

  it('records a read the provider never answered', async () => {
    await logReceiptReading({ ...base, rawResponse: null, extraction: null })
    expect(insert.mock.calls[0][0].raw_response).toBeNull()
  })

  it('defaults the optional context rather than dropping the row', async () => {
    await logReceiptReading({
      accountId: 'acct-1',
      source: 'cotizador',
      provider: 'openai',
      model: 'gpt-x',
      rawResponse: '{}',
      extraction: null,
    })
    const row = insert.mock.calls[0][0]
    expect(row.conversation_id).toBeNull()
    expect(row.contact_id).toBeNull()
    expect(row.media_ids).toEqual([])
  })

  it('caps a model that started narrating instead of answering', async () => {
    await logReceiptReading({
      ...base,
      rawResponse: 'x'.repeat(50_000),
      extraction: null,
    })
    expect(insert.mock.calls[0][0].raw_response).toHaveLength(20_000)
  })

  it('never throws when the insert fails', async () => {
    // A forensic log that can fail a customer's quote is worse than no
    // forensic log. Both call sites fire and forget, so a rejection here
    // would surface as an unhandled rejection.
    insert.mockResolvedValue({ error: { message: 'relation does not exist' } })
    await expect(
      logReceiptReading({ ...base, rawResponse: '{}', extraction: null }),
    ).resolves.toBeUndefined()

    insert.mockRejectedValue(new Error('network down'))
    await expect(
      logReceiptReading({ ...base, rawResponse: '{}', extraction: null }),
    ).resolves.toBeUndefined()
  })
})
