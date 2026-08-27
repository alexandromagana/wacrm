import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  applyLeadStatusTag: vi.fn(),
  applyQuoteSentTag: vi.fn(),
  extractReceipts: vi.fn(),
  saveReceiptData: vi.fn(),
  sendQuoteProposal: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    autoResponderSendSteps: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('./lead-status', () => ({
  applyLeadStatusTag: h.applyLeadStatusTag,
  applyQuoteSentTag: h.applyQuoteSentTag,
}))
vi.mock('./receipt', () => ({
  extractReceipts: h.extractReceipts,
  saveReceiptData: h.saveReceiptData,
  formatReceiptNote: (
    r: { promedio_bimestral_kwh: number | null },
    meters?: { count: number; pending?: { kind: string } },
  ) =>
    `[NOTA: promedio ${r.promedio_bimestral_kwh}` +
    (meters && meters.count > 1 ? ` de ${meters.count} medidores` : '') +
    (meters?.pending ? ` PENDIENTE:${meters.pending.kind}` : '') +
    ']',
  formatHeldQuoteNote: (
    r: { promedio_bimestral_kwh: number | null },
    hold: { reason: string },
  ) => `[NOTA RETOMA: promedio ${r.promedio_bimestral_kwh} motivo ${hold.reason}]`,
  formatStalledQuoteNote: () => '[NOTA COTIZACION ESTANCADA]',
  METERS_MARKER_INSTRUCTION: '[marcador MEDIDORES]',
}))
vi.mock('./quote-pdf', () => ({ sendQuoteProposal: h.sendQuoteProposal }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'automation_steps') {
        // .select().in().in().limit() → send-type steps of those automations
        const chain = {
          select: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({
              data: h.state.autoResponderSendSteps,
              error: null,
            }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

/**
 * Stage the bills `extractReceipts` returns this turn, in arrival
 * order. Each gets its own media id, which is what the meter batch
 * records so an already-read bill is never extracted twice.
 */
function mockBills(...extractions: Record<string, unknown>[]) {
  h.extractReceipts.mockResolvedValue(
    extractions.map((extraction, i) => ({
      extraction,
      mediaIds: [`media-${i + 1}`],
    })),
  )
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    visionModel: 'gpt-test-vision',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  // The receipt-vision limiter allows 4 reads per conversation per 15
  // minutes and its buckets are module-level, so without this every
  // receipt test past the fourth silently skipped extraction — and
  // still passed, because "no proposal was sent" is equally true of a
  // throttled turn. Reset so each test exercises the path it names.
  __resetRateLimitForTests()
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.autoResponderSendSteps = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({
    text: 'Hello!',
    handoff: false,
    leadStatus: null,
  })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.applyLeadStatusTag.mockResolvedValue(undefined)
  h.applyQuoteSentTag.mockResolvedValue(undefined)
  h.extractReceipts.mockResolvedValue([])
  h.saveReceiptData.mockResolvedValue(undefined)
  h.sendQuoteProposal.mockResolvedValue({
    kind: 'skipped',
    reason: 'not_quotable',
  })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('always injects the current date/time note as a user turn', async () => {
    await dispatchInboundToAiReply(ARGS)
    const messages = h.generateReply.mock.calls[0][0].messages as {
      role: string
      content: string
    }[]
    const clockNote = messages.find((m) =>
      m.content.includes('fecha y hora actual'),
    )
    expect(clockNote).toBeTruthy()
    expect(clockNote!.role).toBe('user')
    expect(clockNote!.content).toContain('hora de Cancún')
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation SENDS messages', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    h.state.autoResponderSendSteps = [{ id: 'step-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('coexists with bookkeeping-only message-level automations (no send steps)', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    h.state.autoResponderSendSteps = []
    await dispatchInboundToAiReply(ARGS)
    // A remove_tag-on-reply rule must not silence the bot.
    expect(h.generateReply).toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
  })

  it('hands off instead of sending when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped — the cap was
    // hit concurrently, so the thread gets handed off like any other
    // exhausted-cap conversation instead of silently dropping the reply.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('hands off to a human when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    // The cap is checked before the model is ever called — no LLM spend
    // on a thread that's just going to be handed off.
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned in the
    // shared queue rather than stomping in a random agent.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes the cap-exhausted handoff to the configured agent', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and stays silent when the model wrote no farewell', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('sends the farewell to the customer when the model wrote one, without claiming a reply slot', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Te voy a conectar con Alejandro para que te ayude directamente.',
      handoff: true,
      leadStatus: null,
    })
    await dispatchInboundToAiReply(ARGS)
    // The goodbye goes out...
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: 'Te voy a conectar con Alejandro para que te ayude directamente.',
        aiGenerated: true,
      }),
    )
    // ...but the thread is still paused + summarised, and the send did
    // not go through the reply-slot claim (the bot is retiring here).
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })
})

describe('dispatchInboundToAiReply — lead status', () => {
  it('applies the status tag when the model qualified the lead', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Con gusto te ayudo.',
      handoff: false,
      leadStatus: 'hot',
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.applyLeadStatusTag).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'acct-1',
        contactId: 'contact-1',
        status: 'hot',
      }),
    )
    // The customer still gets the clean reply.
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Con gusto te ayudo.' }),
    )
  })

  it('applies the status tag even on a handoff turn', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Te conecto con Alejandro.',
      handoff: true,
      leadStatus: 'cold',
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.applyLeadStatusTag).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'cold' }),
    )
  })

  it('does not touch tags when no status was emitted', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.applyLeadStatusTag).not.toHaveBeenCalled()
  })

  it('does NOT tag "Quote sent" when the model merely quoted a price in chat', async () => {
    // The marker means "the bot said a number out loud", which happens
    // repeatedly in one conversation. Tagging on it re-applied the tag
    // seconds after the clear-on-reply automation removed it, so the
    // 48h follow-up never had a stable start. The tag now belongs to
    // `sendQuoteProposal`, once the PDF actually goes out.
    h.generateReply.mockResolvedValue({
      text: 'Necesitarías 12 paneles, aprox $106,900.',
      handoff: false,
      leadStatus: 'hot',
      quoteSent: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.applyQuoteSentTag).not.toHaveBeenCalled()
    // The customer still gets the clean reply, marker-free.
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Necesitarías 12 paneles, aprox $106,900.',
      }),
    )
  })

  it('does not tag "Quote sent" on ordinary replies', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.applyQuoteSentTag).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — CFE receipt images', () => {
  const RECEIPT_ARGS = {
    ...ARGS,
    receiptMediaIds: ['media-1', 'media-2'],
    accessToken: 'meta-token',
  }

  it('extracts, saves the field, and injects the reading into the turn', async () => {
    mockBills({
      consumo_periodo_actual_kwh: 1450,
      periodo_actual: null,
      historial_bimestres_kwh: [1380, 1420],
      cantidad_periodos_usados: 3,
      promedio_bimestral_kwh: 1417,
      tarifa: null,
      advertencias: '',
    })
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    expect(h.extractReceipts).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'meta-token',
        mediaIds: ['media-1', 'media-2'],
      }),
    )
    expect(h.saveReceiptData).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contactId: 'contact-1' }),
    )
    // The reading reaches the model as the final user turn.
    const messages = h.generateReply.mock.calls[0][0].messages as {
      role: string
      content: string
    }[]
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: '[NOTA: promedio 1417]',
    })
    // And the customer still gets a normal text reply.
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
  })

  it('replies even when the conversation has no prior text (image-only turn)', async () => {
    h.buildConversationContext.mockResolvedValue([])
    mockBills({
      consumo_periodo_actual_kwh: null,
      periodo_actual: null,
      historial_bimestres_kwh: [],
      cantidad_periodos_usados: 0,
      promedio_bimestral_kwh: 1200,
      tarifa: null,
      advertencias: '',
    })
    await dispatchInboundToAiReply(RECEIPT_ARGS)
    expect(h.generateReply).toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('injects a receipt-only re-ask note on failure — never offers the kWh fallback', async () => {
    h.extractReceipts.mockResolvedValue([])
    await dispatchInboundToAiReply(RECEIPT_ARGS)
    expect(h.saveReceiptData).not.toHaveBeenCalled()
    const note = (
      h.generateReply.mock.calls[0][0].messages as {
        role: string
        content: string
      }[]
    ).at(-1)!.content
    // Insists on resending the receipt, and explicitly forbids the bot
    // from offering the kWh fallback (customers don't know that number).
    expect(note).toContain('recibo')
    expect(note).toMatch(/NUNCA le pidas.*kWh/i)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('runs no extraction on a plain text turn', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.extractReceipts).not.toHaveBeenCalled()
  })

  it('sends the proposal from the same reading, after the text reply', async () => {
    const reading = {
      consumo_periodo_actual_kwh: 2944,
      periodo_actual: null,
      historial_bimestres_kwh: [2177, 1487, 1447, 1966, 2788],
      cantidad_periodos_usados: 6,
      promedio_bimestral_kwh: 2135,
      tarifa: '1D',
      costo_periodo_mxn: 10237.3,
      advertencias: '',
    }
    mockBills(reading)
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    expect(h.sendQuoteProposal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contactId: 'contact-1',
        extraction: reading,
      }),
    )
    // Order matters: the text explains the numbers the document shows,
    // and a PDF failure must not cost the customer their reply.
    expect(h.engineSendText.mock.invocationCallOrder[0]).toBeLessThan(
      h.sendQuoteProposal.mock.invocationCallOrder[0],
    )
  })

  // ----------------------------------------------------------------
  // Properties split across several CFE meters. Each bill prices
  // cleanly on its own, which is exactly why quoting one is wrong: the
  // system gets sized for a fraction of the house.
  // ----------------------------------------------------------------

  /** Two bills that differ by service number — a real second meter. */
  const METER_A = {
    promedio_bimestral_kwh: 1000,
    cantidad_periodos_usados: 6,
    incluye_periodo_actual: true,
    periodos_promediados_kwh: [1000, 1000, 1000, 1000, 1000, 1000],
    historial_bimestres_kwh: [1000, 1000, 1000, 1000, 1000],
    historial_bimestres_periodo: [
      'del 22 MAR 26 al 22 MAY 26',
      'del 22 ENE 26 al 22 MAR 26',
      'del 22 NOV 25 al 22 ENE 26',
      'del 22 SEP 25 al 22 NOV 25',
      'del 22 JUL 25 al 22 SEP 25',
    ],
    historial_bimestres_importe_mxn: [4000, 4000, 4000, 4000, 4000],
    consumo_periodo_actual_kwh: 1000,
    periodo_actual: '22 MAY 26 - 22 JUL 26',
    tarifa: '1D',
    numero_servicio: '782990401509',
    costo_periodo_mxn: 4000,
    advertencias: '',
  }
  const METER_B = {
    ...METER_A,
    numero_servicio: '782250505386',
    promedio_bimestral_kwh: 700,
    consumo_periodo_actual_kwh: 700,
    periodos_promediados_kwh: [700, 700, 700, 700, 700, 700],
    historial_bimestres_kwh: [700, 700, 700, 700, 700],
    costo_periodo_mxn: 2800,
  }

  it('holds the proposal when a second meter arrives unannounced', async () => {
    mockBills(METER_A, METER_B)
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    // The document must wait: a sum of two meters the customer has not
    // confirmed is not a quote, it is a guess about their house.
    expect(h.sendQuoteProposal).not.toHaveBeenCalled()
    const note = (
      h.generateReply.mock.calls[0][0].messages as { content: string }[]
    ).at(-1)!.content
    expect(note).toContain('PENDIENTE:awaiting_confirmation')
    // The customer is still answered — the bot asks its question.
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('quotes the sum on the turn the customer confirms the count', async () => {
    mockBills(METER_A, METER_B)
    h.generateReply.mockResolvedValue({
      text: 'Perfecto, con esos dos te preparo la propuesta',
      handoff: false,
      leadStatus: null,
      metersExpected: 2,
    })
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    // 1,000 + 700 — one system for the whole property, not two for
    // halves of it.
    expect(h.sendQuoteProposal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        extraction: expect.objectContaining({
          promedio_bimestral_kwh: 1700,
          costo_periodo_mxn: 6800,
        }),
      }),
    )
  })

  it('keeps waiting while a stated count is still short', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      ai_meter_state: {
        expected: 3,
        readings: [METER_A],
        readMediaIds: ['old-media'],
        askedCount: 0,
        updatedAt: new Date().toISOString(),
      },
    }
    mockBills(METER_B)
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    expect(h.sendQuoteProposal).not.toHaveBeenCalled()
    const note = (
      h.generateReply.mock.calls[0][0].messages as { content: string }[]
    ).at(-1)!.content
    expect(note).toContain('PENDIENTE:awaiting_more')
  })

  it('never pays to read the same bill twice', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      ai_meter_state: {
        expected: null,
        readings: [METER_A],
        readMediaIds: ['media-1'],
        askedCount: 0,
        updatedAt: new Date().toISOString(),
      },
    }
    mockBills(METER_B)
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    expect(h.extractReceipts).toHaveBeenCalledWith(
      expect.objectContaining({ skipMediaIds: ['media-1'] }),
    )
  })

  it('asks for a resend only when it is holding nothing', async () => {
    // A burst that re-reports bills already in the batch reads as "no
    // new bills". That is not a failed read, and asking the customer to
    // resend a receipt we are holding is how a working conversation
    // starts going in circles.
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      ai_meter_state: {
        expected: null,
        readings: [METER_A],
        readMediaIds: ['media-1'],
        askedCount: 0,
        updatedAt: new Date().toISOString(),
      },
    }
    h.extractReceipts.mockResolvedValue([])
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    const note = (
      h.generateReply.mock.calls[0][0].messages as { content: string }[]
    ).at(-1)!.content
    expect(note).not.toMatch(/NUNCA le pidas.*kWh/i)
    expect(h.sendQuoteProposal).toHaveBeenCalled()
  })

  const STALLED_BATCH = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
    ai_meter_state: {
      expected: null,
      readings: [METER_A, METER_B],
      readMediaIds: ['media-1', 'media-2'],
      askedCount: 2,
      updatedAt: new Date().toISOString(),
    },
  }

  it('hands off instead of asking a third time', async () => {
    h.state.conv = { ...STALLED_BATCH }
    h.extractReceipts.mockResolvedValue([])
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    expect(h.sendQuoteProposal).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'how many meters',
    )
  })

  it('answers the customer before handing a stalled batch to a person', async () => {
    // An open batch outlives the topic that opened it. The message that
    // trips the limit is usually about something else — this customer is
    // comparing financing offers — and escalating in silence reads as
    // being ignored.
    h.state.conv = { ...STALLED_BATCH }
    h.extractReceipts.mockResolvedValue([])
    h.generateReply.mockResolvedValue({
      text: 'Sí, manejamos financiamiento hasta 60 meses 🙌',
      handoff: false,
    })
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('financiamiento') }),
    )
    // Answered, then escalated — and still no quote for a property we
    // only partly covered.
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.sendQuoteProposal).not.toHaveBeenCalled()
  })

  it('stops escalating when the stalled batch closes on this turn', async () => {
    // The customer finally states the count on the third turn. Now that
    // the model gets a turn at all, that answer can land — and once the
    // quote is out there is nothing left for a person to chase.
    h.state.conv = { ...STALLED_BATCH }
    h.extractReceipts.mockResolvedValue([])
    h.generateReply.mockResolvedValue({
      text: 'Son dos, va tu propuesta 🙌',
      handoff: false,
      metersExpected: 2,
    })
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    expect(h.sendQuoteProposal).toHaveBeenCalled()
    expect(h.state.updatePayload?.ai_autoreply_disabled).not.toBe(true)
  })

  it('tells the model to drop the meter question and answer what was asked', async () => {
    h.state.conv = { ...STALLED_BATCH }
    h.extractReceipts.mockResolvedValue([])
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    const note = (
      h.generateReply.mock.calls[0][0].messages as { content: string }[]
    ).at(-1)!.content
    expect(note).toMatch(/NO vuelvas a preguntar cuántos medidores/i)
    expect(note).toMatch(/NO des precio/i)
  })

  it('does not re-quote a settled batch on a later text turn', async () => {
    // The batch survives a proposal that was held back for review. It
    // must not then re-offer itself on every message that follows — the
    // customer said "gracias", not "quote me again".
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      ai_meter_state: {
        expected: null,
        readings: [METER_A],
        readMediaIds: ['media-1'],
        askedCount: 0,
        updatedAt: new Date().toISOString(),
      },
    }
    await dispatchInboundToAiReply(ARGS)

    expect(h.sendQuoteProposal).not.toHaveBeenCalled()
    const messages = h.generateReply.mock.calls[0][0].messages as {
      content: string
    }[]
    expect(messages.some((m) => m.content.startsWith('[NOTA: promedio'))).toBe(
      false,
    )
  })

  it('carries the marker instruction on a text-only answer turn', async () => {
    // The customer answers "sí, son esos dos" in words. No image, so
    // without this note the count would never reach the model's output
    // and the batch would wait forever.
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      ai_meter_state: {
        expected: null,
        readings: [METER_A, METER_B],
        readMediaIds: ['media-1', 'media-2'],
        askedCount: 1,
        updatedAt: new Date().toISOString(),
      },
    }
    await dispatchInboundToAiReply(ARGS)

    const note = (
      h.generateReply.mock.calls[0][0].messages as { content: string }[]
    ).at(-1)!.content
    expect(note).toContain('[marcador MEDIDORES]')
    expect(h.sendQuoteProposal).not.toHaveBeenCalled()
  })

  it('sends no proposal on a plain text turn', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendQuoteProposal).not.toHaveBeenCalled()
  })

  it('sends no proposal when the reading failed', async () => {
    h.extractReceipts.mockResolvedValue([])
    await dispatchInboundToAiReply(RECEIPT_ARGS)
    expect(h.sendQuoteProposal).not.toHaveBeenCalled()
  })

  it('still sends the proposal when the model hands off on the same turn', async () => {
    // The quote is computed and the customer is waiting for it. A
    // handoff on this turn is about something else — escalating must not
    // swallow a document the customer already earned. The bot still
    // pauses, after the send.
    mockBills({
      promedio_bimestral_kwh: 2135,
      cantidad_periodos_usados: 6,
      historial_bimestres_kwh: [],
      consumo_periodo_actual_kwh: 2944,
      periodo_actual: null,
      tarifa: null,
      advertencias: '',
    })
    h.generateReply.mockResolvedValue({ text: 'Te paso con alguien', handoff: true })
    await dispatchInboundToAiReply(RECEIPT_ARGS)
    expect(h.sendQuoteProposal).toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })

  it('sends the proposal when the model returns only the meters marker', async () => {
    // Marker-only output strips to empty text. The proposal PDF ships
    // without a caption, so the customer would get a bare document —
    // the fallback line carries it.
    mockBills({
      promedio_bimestral_kwh: 2135,
      cantidad_periodos_usados: 6,
      historial_bimestres_kwh: [],
      consumo_periodo_actual_kwh: 2944,
      periodo_actual: null,
      tarifa: null,
      advertencias: '',
    })
    h.generateReply.mockResolvedValue({ text: '', handoff: false })
    await dispatchInboundToAiReply(RECEIPT_ARGS)
    expect(h.sendQuoteProposal).toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('propuesta') }),
    )
  })

  it('still replies when the proposal blows up', async () => {
    // sendQuoteProposal owns its errors, but if one ever escapes it must
    // not retroactively break a reply the customer already received.
    mockBills({
      promedio_bimestral_kwh: 2135,
      cantidad_periodos_usados: 6,
      historial_bimestres_kwh: [],
      consumo_periodo_actual_kwh: 2944,
      periodo_actual: null,
      tarifa: null,
      advertencias: '',
    })
    h.sendQuoteProposal.mockRejectedValue(new Error('storage down'))
    await expect(dispatchInboundToAiReply(RECEIPT_ARGS)).resolves.toBeUndefined()
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  // ----------------------------------------------------------------
  // A proposal priced and deliberately not sent.
  //
  // Tony's thread is what this is for. The pricing layer read his bill
  // correctly and shipped the PDF; the model, on its own reading of the
  // same history, spent that turn asking whether the house had been
  // empty — so the customer got an interrogation with a quote stapled
  // underneath. Then he answered, and the bot — with the reading long
  // gone from its context — replied with a panel count it made up and
  // no document at all.
  //
  // Both halves are covered here: the model can stop the send, and the
  // answer it waited for can start it.
  // ----------------------------------------------------------------

  /** A bill already read, parked on a question, as the column stores it. */
  const parked = (hold: Record<string, unknown>) => ({
    expected: null,
    readings: [
      {
        consumo_periodo_actual_kwh: 1725,
        periodo_actual: 'del 12 JUN 26 al 13 AGO 26',
        historial_bimestres_kwh: [1352, 646, 477, 820, 1200],
        historial_bimestres_periodo: [null, null, null, null, null],
        cantidad_periodos_usados: 6,
        promedio_bimestral_kwh: 1036,
        incluye_periodo_actual: true,
        periodos_promediados_kwh: [1725, 1352, 646, 477, 820, 1200],
        tarifa: '1D',
        numero_servicio: '783940411500',
        ciudad: 'CANCUN',
        importe_periodo_mxn: 4165.39,
        importe_dap_mxn: 179.54,
        importe_total_a_pagar_mxn: 4345.4,
        historial_bimestres_importe_mxn: [2516, 1766, 977, 2596, 1734],
        costo_periodo_mxn: 4344.93,
        advertencias: '',
      },
    ],
    readMediaIds: ['media-1'],
    askedCount: 0,
    hold,
    updatedAt: new Date().toISOString(),
  })

  const cleanBill = {
    consumo_periodo_actual_kwh: 2944,
    periodo_actual: null,
    historial_bimestres_kwh: [2177, 1487, 1447, 1966, 2788],
    cantidad_periodos_usados: 6,
    promedio_bimestral_kwh: 2135,
    tarifa: '1D',
    costo_periodo_mxn: 10237.3,
    advertencias: '',
  }

  it('lets the model stop a send it is about to contradict', async () => {
    mockBills(cleanBill)
    h.generateReply.mockResolvedValue({
      text: '¿Ese recibo es de la casa que vas a equipar?',
      handoff: false,
      holdQuote: true,
      holdReason: 'confirmar el domicilio',
    })
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    // The question goes out alone. That is the whole fix.
    expect(h.engineSendText).toHaveBeenCalled()
    expect(h.sendQuoteProposal).not.toHaveBeenCalled()
    expect(h.state.updatePayload?.ai_meter_state).toMatchObject({
      hold: {
        reason: 'model',
        detail: 'confirmar el domicilio',
        askedCount: 1,
      },
    })
  })

  it('parks the quote the pricing layer held, so it can come back', async () => {
    mockBills(cleanBill)
    h.sendQuoteProposal.mockResolvedValue({
      kind: 'skipped',
      reason: 'needs_review',
      review: 'anomalous_history',
    })
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    expect(h.state.updatePayload?.ai_meter_state).toMatchObject({
      hold: { reason: 'anomalous_history', askedCount: 1 },
    })
  })

  it('puts the reading back in front of the model on the answering turn', async () => {
    // No new receipt this turn — just the customer explaining. Before
    // this the reading was gone and the model answered from memory it
    // did not have.
    h.state.conv!.ai_meter_state = parked({
      reason: 'anomalous_history',
      askedCount: 1,
    })
    await dispatchInboundToAiReply(ARGS)

    const note = (
      h.generateReply.mock.calls[0][0].messages as { content: string }[]
    ).at(-1)!.content
    expect(note).toBe('[NOTA RETOMA: promedio 1036 motivo anomalous_history]')
  })

  it('sends the parked proposal once the customer confirms the consumption', async () => {
    h.state.conv!.ai_meter_state = parked({
      reason: 'anomalous_history',
      askedCount: 1,
    })
    h.generateReply.mockResolvedValue({
      text: 'Perfecto, entonces vamos con 8 paneles.',
      handoff: false,
      consumptionVerdict: 'normal',
    })
    await dispatchInboundToAiReply(ARGS)

    expect(h.sendQuoteProposal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reviewCleared: true,
        extraction: expect.objectContaining({ promedio_bimestral_kwh: 1036 }),
      }),
    )
  })

  it('fetches a person instead when the history turns out not to be theirs', async () => {
    h.state.conv!.ai_meter_state = parked({
      reason: 'anomalous_history',
      askedCount: 1,
    })
    h.generateReply.mockResolvedValue({
      text: 'Entiendo, un compañero te contacta.',
      handoff: false,
      consumptionVerdict: 'atypical',
    })
    await dispatchInboundToAiReply(ARGS)

    // No document — an empty house's average sizes nothing — and the
    // customer still got answered before the thread changed hands.
    expect(h.sendQuoteProposal).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'consumption history needs explaining',
    )
  })

  it('keeps the quote parked while the answer is still unclear', async () => {
    h.state.conv!.ai_meter_state = parked({
      reason: 'anomalous_history',
      askedCount: 1,
    })
    await dispatchInboundToAiReply(ARGS)

    expect(h.sendQuoteProposal).not.toHaveBeenCalled()
    expect(h.state.updatePayload?.ai_meter_state).toMatchObject({
      hold: { reason: 'anomalous_history', askedCount: 2 },
    })
  })

  it('stops asking after the second try and hands the quote to a person', async () => {
    h.state.conv!.ai_meter_state = parked({
      reason: 'anomalous_history',
      askedCount: 3,
    })
    await dispatchInboundToAiReply(ARGS)

    const note = (
      h.generateReply.mock.calls[0][0].messages as { content: string }[]
    ).at(-1)!.content
    expect(note).toBe('[NOTA COTIZACION ESTANCADA]')
    expect(h.sendQuoteProposal).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })
})
