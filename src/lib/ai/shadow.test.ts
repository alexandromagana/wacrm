import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AiError, type AiConfig, type GenerateResult } from './types'

const h = vi.hoisted(() => ({ generateReply: vi.fn() }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))

import { parseShadowArms, runShadow } from './shadow'

function result(overrides: Partial<GenerateResult> = {}): GenerateResult {
  return {
    text: 'Claro, con gusto.',
    handoff: false,
    leadStatus: null,
    quoteSent: false,
    metersExpected: null,
    holdQuote: false,
    holdReason: null,
    consumptionVerdict: null,
    packagePanels: null,
    usage: { promptTokens: 8600, completionTokens: 80, totalTokens: 8680 },
    ...overrides,
  }
}

const CONFIG: AiConfig = {
  provider: 'openai',
  model: 'gpt-5.6-terra',
  visionModel: 'gpt-5.6-luna',
  reasoningEffort: null,
  apiKey: 'sk-test',
  systemPrompt: 'negocio',
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
  handoffAgentId: null,
  embeddingsApiKey: null,
}

function fakeDb() {
  const insert = vi.fn().mockResolvedValue({ error: null })
  const from = vi.fn(() => ({ insert }))
  return { db: { from } as unknown as SupabaseClient, insert, from }
}

function args() {
  return {
    accountId: 'acct-1',
    conversationId: 'conv-1',
    config: CONFIG,
    systemPrompt: 'sys',
    messages: [{ role: 'user' as const, content: 'Hola' }],
    baseline: result({ text: 'Hola, ¿me compartes tu recibo?' }),
    baselineLatencyMs: 1200,
  }
}

beforeEach(() => {
  h.generateReply.mockReset()
})

describe('parseShadowArms', () => {
  it('reads model:effort pairs, with no suffix or :default meaning unset', () => {
    expect(
      parseShadowArms('gpt-6.1-sol:low, gpt-6.1-sol:medium,gpt-6-luna,gpt-6-luna:default'),
    ).toEqual([
      { model: 'gpt-6.1-sol', reasoningEffort: 'low' },
      { model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
      { model: 'gpt-6-luna', reasoningEffort: null },
      { model: 'gpt-6-luna', reasoningEffort: null },
    ])
  })

  it('is off when unset or blank', () => {
    expect(parseShadowArms(undefined)).toEqual([])
    expect(parseShadowArms('  ')).toEqual([])
  })

  it('drops an arm whose effort it does not know instead of sending it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseShadowArms('gpt-6.1-sol:lo,gpt-6.1-sol:high')).toEqual([
      { model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    ])
    warn.mockRestore()
  })
})

describe('runShadow', () => {
  it('does nothing at all without arms', async () => {
    const { db, from } = fakeDb()
    await runShadow(db, args(), [])
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
  })

  it('answers the same turn with each candidate and records it next to the baseline', async () => {
    h.generateReply.mockResolvedValue(
      result({
        text: 'Claro, mándame tu recibo.',
        leadStatus: 'warm',
        usage: {
          promptTokens: 8600,
          completionTokens: 300,
          totalTokens: 8900,
          cachedTokens: 7000,
          reasoningTokens: 220,
        },
      }),
    )
    const { db, insert, from } = fakeDb()

    await runShadow(db, args(), [{ model: 'gpt-6.1-sol', reasoningEffort: 'low' }])

    const [call] = h.generateReply.mock.calls
    expect(call[0].config).toMatchObject({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'low',
    })
    expect(call[0].systemPrompt).toBe('sys')
    expect(call[0].messages).toEqual([{ role: 'user', content: 'Hola' }])

    expect(from).toHaveBeenCalledWith('ai_shadow_runs')
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: 'acct-1',
        conversation_id: 'conv-1',
        model: 'gpt-6.1-sol',
        reasoning_effort: 'low',
        baseline_model: 'gpt-5.6-terra',
        baseline_text: 'Hola, ¿me compartes tu recibo?',
        shadow_text: 'Claro, mándame tu recibo.',
        shadow_markers: expect.objectContaining({ leadStatus: 'warm', handoff: false }),
        cached_tokens: 7000,
        reasoning_tokens: 220,
        baseline_latency_ms: 1200,
        error: null,
      }),
    )
  })

  it('sees the turn as it was answered, even if the caller keeps editing its array', async () => {
    h.generateReply.mockResolvedValue(result())
    const { db } = fakeDb()
    const a = args()

    const pending = runShadow(db, a, [{ model: 'gpt-6.1-sol', reasoningEffort: 'low' }])
    a.messages.push({ role: 'user', content: 'otro turno' })
    await pending

    expect(h.generateReply.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'Hola' },
    ])
  })

  it('records a failed candidate instead of throwing', async () => {
    h.generateReply.mockImplementation(async () => {
      throw new AiError('OpenAI API error (400): Unsupported value: none', {
        code: 'provider_error',
      })
    })
    const { db, insert } = fakeDb()

    await expect(
      runShadow(db, args(), [{ model: 'gpt-6.1-sol', reasoningEffort: 'none' }]),
    ).resolves.toBeUndefined()

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        shadow_text: null,
        shadow_markers: null,
        error: expect.stringMatching(/^provider_error: .*Unsupported value/),
      }),
    )
  })

  it('never rejects when the insert itself fails', async () => {
    h.generateReply.mockResolvedValue(result())
    const insert = vi.fn(async () => {
      throw new Error('db down')
    })
    const db = { from: () => ({ insert }) } as unknown as SupabaseClient
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      runShadow(db, args(), [{ model: 'gpt-6.1-sol', reasoningEffort: 'low' }]),
    ).resolves.toBeUndefined()
    error.mockRestore()
  })
})
