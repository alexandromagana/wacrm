import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      leadStatus: null,
      quoteSent: false,
      usage: null,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      leadStatus: null,
      quoteSent: false,
      usage: null,
    })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      leadStatus: null,
      quoteSent: false,
      usage: null,
    })
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      leadStatus: null,
      quoteSent: false,
      usage,
    })
  })
})

describe('parseGeneration — status markers', () => {
  it('parses + strips a Spanish marker', () => {
    const res = parseGeneration('Con gusto te cotizo. [ESTATUS: CALIENTE]')
    expect(res.text).toBe('Con gusto te cotizo.')
    expect(res.leadStatus).toBe('hot')
  })

  it('parses English markers and ignores case/spacing', () => {
    expect(parseGeneration('Sure! [status: warm ]').leadStatus).toBe('warm')
    expect(parseGeneration('Ok [STATUS:COLD]').leadStatus).toBe('cold')
  })

  it('handles accents (FRÍO → cold)', () => {
    const res = parseGeneration('Gracias por tu interés. [ESTATUS: FRÍO]')
    expect(res.text).toBe('Gracias por tu interés.')
    expect(res.leadStatus).toBe('cold')
  })

  it('strips unknown status values without setting a status', () => {
    const res = parseGeneration('Hola [ESTATUS: TEMPLADO]')
    expect(res.text).toBe('Hola')
    expect(res.leadStatus).toBeNull()
  })

  it('combines with a handoff farewell', () => {
    const res = parseGeneration(
      'Te voy a conectar con Alejandro. [ESTATUS: CALIENTE] [[HANDOFF]]',
    )
    expect(res.text).toBe('Te voy a conectar con Alejandro.')
    expect(res.handoff).toBe(true)
    expect(res.leadStatus).toBe('hot')
  })

  it('last valid marker wins when the model emits several', () => {
    const res = parseGeneration('[ESTATUS: TIBIO] Hola [ESTATUS: CALIENTE]')
    expect(res.text).toBe('Hola')
    expect(res.leadStatus).toBe('hot')
  })
})

describe('parseGeneration — quote marker', () => {
  it('detects + strips [COTIZACION_ENVIADA]', () => {
    const res = parseGeneration(
      'Necesitarías 12 paneles, aprox $106,900. [COTIZACION_ENVIADA]',
    )
    expect(res.text).toBe('Necesitarías 12 paneles, aprox $106,900.')
    expect(res.quoteSent).toBe(true)
  })

  it('tolerates accents, spaces, and the English spelling', () => {
    expect(parseGeneration('Precio X [COTIZACIÓN ENVIADA]').quoteSent).toBe(true)
    expect(parseGeneration('Precio X [quote_sent]').quoteSent).toBe(true)
    expect(parseGeneration('Precio X [ QUOTE SENT ]').quoteSent).toBe(true)
  })

  it('combines with status marker and handoff', () => {
    const res = parseGeneration(
      'Tu paquete: 14 paneles. [COTIZACION_ENVIADA] [ESTATUS: CALIENTE]',
    )
    expect(res.text).toBe('Tu paquete: 14 paneles.')
    expect(res.quoteSent).toBe(true)
    expect(res.leadStatus).toBe('hot')
  })

  it('stays false on ordinary replies', () => {
    expect(parseGeneration('¿Me compartes tu recibo?').quoteSent).toBe(false)
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      leadStatus: null,
      quoteSent: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      leadStatus: null,
      quoteSent: false,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})
