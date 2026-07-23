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
  extractReceipt: vi.fn(),
  saveReceiptData: vi.fn(),
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
  extractReceipt: h.extractReceipt,
  saveReceiptData: h.saveReceiptData,
  formatReceiptNote: (r: { promedio_bimestral_kwh: number | null }) =>
    `[NOTA: promedio ${r.promedio_bimestral_kwh}]`,
}))
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

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
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
  h.extractReceipt.mockResolvedValue(null)
  h.saveReceiptData.mockResolvedValue(undefined)
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

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
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

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
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

  it('tags "Quote sent" when the model marked the turn as a quote', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Necesitarías 12 paneles, aprox $106,900.',
      handoff: false,
      leadStatus: 'hot',
      quoteSent: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.applyQuoteSentTag).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId: 'acct-1', contactId: 'contact-1' }),
    )
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
    h.extractReceipt.mockResolvedValue({
      consumo_periodo_actual_kwh: 1450,
      periodo_actual: null,
      historial_bimestres_kwh: [1380, 1420],
      cantidad_periodos_usados: 3,
      promedio_bimestral_kwh: 1417,
      tarifa: null,
      advertencias: '',
    })
    await dispatchInboundToAiReply(RECEIPT_ARGS)

    expect(h.extractReceipt).toHaveBeenCalledWith(
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
    h.extractReceipt.mockResolvedValue({
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
    h.extractReceipt.mockResolvedValue(null)
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
    expect(h.extractReceipt).not.toHaveBeenCalled()
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
})
