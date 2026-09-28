import { describe, it, expect, beforeEach, vi } from 'vitest'

// Send steps for a contact with no conversation — the Facebook lead who
// filled in the form but never wrote. Runs the engine, the automation
// sender and the shared conversation helper for real, and fakes only the
// database and Meta, so the assertions are about the rows an automation
// leaves behind rather than which helper got called.

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  seq: 0,
  sendTemplateMessage: vi.fn(),
  sendTextMessage: vi.fn(),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
}))

vi.mock('./admin-client', () => {
  // In-memory stand-in for the service-role client: just enough
  // PostgREST (eq / is / gte filters, limit, single, maybeSingle, awaited
  // lists, insert, update) for the queries a send step makes.
  function from(table: string) {
    const rows = (h.tables[table] ??= [])
    const filters: Array<(r: Row) => boolean> = []
    let op: 'select' | 'insert' | 'update' = 'select'
    let payload: Row = {}
    let max = Infinity

    const run = (): Row[] => {
      if (op === 'insert') {
        const row = { id: `${table}-${++h.seq}`, ...payload }
        rows.push(row)
        return [row]
      }
      const hits = rows.filter((r) => filters.every((f) => f(r))).slice(0, max)
      if (op === 'update') hits.forEach((r) => Object.assign(r, payload))
      return hits
    }

    const q: Record<string, unknown> = {
      select: () => q,
      insert: (p: Row) => ((op = 'insert'), (payload = p), q),
      update: (p: Row) => ((op = 'update'), (payload = p), q),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
      gte: (k: string, v: number) => (filters.push((r) => Number(r[k]) >= v), q),
      order: () => q,
      limit: (n: number) => ((max = n), q),
      single: () => {
        const [row] = run()
        return Promise.resolve(
          row ? { data: row, error: null } : { data: null, error: { message: 'no rows' } },
        )
      },
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(onF, onR),
    }
    return q
  }

  return {
    supabaseAdmin: () => ({ from, rpc: () => Promise.resolve({ error: null }) }),
  }
})

// Only the network calls; the payload limits the validators read stay real.
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: h.sendTemplateMessage,
  sendTextMessage: h.sendTextMessage,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendInteractiveButtons: h.engineSendInteractiveButtons,
  engineSendInteractiveList: h.engineSendInteractiveList,
}))

import { runAutomationsForTrigger } from './engine'

const ACCOUNT = 'acct-1'
const TAG = 'tag-fb-pendiente'

/** The production step: "FB Pendiente WA → pedir recibo". */
const TEMPLATE_STEP = {
  step_type: 'send_template',
  step_config: {
    template_name: 'gama_seguimiento_lead',
    language: 'es_MX',
    variables: { '1': '{{contact.first_name|cliente}}' },
  },
}

/** A tag_added automation running `steps`, for a contact with no chat. */
function seed(steps: Row[], extra: Record<string, Row[]> = {}) {
  h.seq = 0
  h.tables = {
    contacts: [{ id: 'c1', account_id: ACCOUNT, name: 'Ana López', phone: '+52 1 55 1234 5678' }],
    automations: [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'author-1',
        trigger_type: 'tag_added',
        trigger_config: { tag_id: TAG },
        is_active: true,
      },
    ],
    automation_steps: steps.map((s, i) => ({
      id: `s${i}`,
      automation_id: 'a1',
      position: i,
      parent_step_id: null,
      ...s,
    })),
    whatsapp_config: [
      { id: 'wa-1', account_id: ACCOUNT, user_id: 'owner-1', phone_number_id: 'pn-1', access_token: 'cipher' },
    ],
    message_templates: [
      {
        id: 'tpl-1',
        account_id: ACCOUNT,
        user_id: 'owner-1',
        name: 'gama_seguimiento_lead',
        language: 'es_MX',
        body_text: 'Hola {{1}}, ¿nos compartes tu recibo de luz?',
        header_type: null,
        buttons: [],
      },
    ],
    conversations: [],
    messages: [],
    automation_logs: [],
    ...extra,
  }
}

function tagLead() {
  return runAutomationsForTrigger({
    accountId: ACCOUNT,
    triggerType: 'tag_added',
    contactId: 'c1',
    context: { tag_id: TAG },
  })
}

const log = () => h.tables.automation_logs[0]

beforeEach(() => {
  vi.clearAllMocks()
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.lead' })
  h.sendTextMessage.mockResolvedValue({ messageId: 'wamid.text' })
  h.engineSendInteractiveButtons.mockResolvedValue({ whatsapp_message_id: 'wamid.buttons' })
  h.engineSendInteractiveList.mockResolvedValue({ whatsapp_message_id: 'wamid.list' })
})

describe('send_template for a contact with no conversation', () => {
  it('opens the conversation and sends the template', async () => {
    seed([TEMPLATE_STEP])

    await tagLead()

    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(h.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '5215512345678',
        templateName: 'gama_seguimiento_lead',
        language: 'es_MX',
        params: ['Ana'],
      }),
    )

    // One conversation, owned like the one the webhook would have opened
    // had the lead written first, so their reply lands in it.
    expect(h.tables.conversations).toHaveLength(1)
    const [conversation] = h.tables.conversations
    expect(conversation).toMatchObject({
      account_id: ACCOUNT,
      contact_id: 'c1',
      user_id: 'owner-1',
      last_message_text: '[template:gama_seguimiento_lead]',
      last_message_at: expect.any(String),
    })

    // The message sits in it with Meta's id, which is what the webhook's
    // delivered / read / failed updates match on.
    expect(h.tables.messages).toEqual([
      expect.objectContaining({
        conversation_id: conversation.id,
        sender_type: 'bot',
        content_type: 'template',
        template_name: 'gama_seguimiento_lead',
        message_id: 'wamid.lead',
        status: 'sent',
      }),
    ])

    expect(log()).toMatchObject({
      status: 'success',
      steps_executed: [
        expect.objectContaining({
          step_type: 'send_template',
          status: 'success',
          detail: 'template sent via Meta (wamid.lead)',
        }),
      ],
    })
  })

  it('opens nothing when Meta refuses the template', async () => {
    seed([TEMPLATE_STEP])
    h.sendTemplateMessage.mockRejectedValue(
      new Error('(#132001) Template name does not exist in the translation'),
    )

    await tagLead()

    expect(h.tables.conversations).toHaveLength(0)
    expect(h.tables.messages).toHaveLength(0)
    expect(log()).toMatchObject({
      status: 'failed',
      error_message: expect.stringContaining('132001'),
    })
  })

  it('sends into the conversation a contact already has, and leaves its place', async () => {
    seed([TEMPLATE_STEP], {
      conversations: [
        {
          id: 'conv-1',
          account_id: ACCOUNT,
          contact_id: 'c1',
          user_id: 'owner-1',
          last_message_at: '2026-09-01T10:00:00.000Z',
        },
      ],
    })

    await tagLead()

    expect(h.tables.conversations).toHaveLength(1)
    expect(h.tables.conversations[0].last_message_at).toBe('2026-09-01T10:00:00.000Z')
    expect(h.tables.messages).toEqual([
      expect.objectContaining({ conversation_id: 'conv-1', message_id: 'wamid.lead' }),
    ])
    expect(log()).toMatchObject({ status: 'success' })
  })
})

describe('free-form send steps still need a conversation', () => {
  // Meta delivers these only inside the 24h window a customer's own
  // message opens, so for a lead who never wrote they must fail — with
  // the error text the crm-auditor classifies — and open nothing.
  it.each([
    ['send_message', { text: 'Hola, ¿nos compartes tu recibo?' }],
    [
      'send_buttons',
      { kind: 'buttons', body: '¿Ya tienes tu recibo?', buttons: [{ id: 'si', title: 'Sí' }] },
    ],
    [
      'send_list',
      {
        kind: 'list',
        body: 'Elige una opción',
        button_label: 'Opciones',
        sections: [{ rows: [{ id: 'recibo', title: 'Mandar recibo' }] }],
      },
    ],
  ])('%s fails cleanly and opens nothing', async (step_type, step_config) => {
    seed([{ step_type, step_config }])

    await tagLead()

    expect(log()).toMatchObject({
      status: 'failed',
      error_message: 'no conversation for contact',
      steps_executed: [
        expect.objectContaining({
          step_type,
          status: 'failed',
          detail: 'no conversation for contact',
        }),
      ],
    })
    expect(h.tables.conversations).toHaveLength(0)
    expect(h.tables.messages).toHaveLength(0)
    expect(h.sendTextMessage).not.toHaveBeenCalled()
    expect(h.engineSendInteractiveButtons).not.toHaveBeenCalled()
    expect(h.engineSendInteractiveList).not.toHaveBeenCalled()
  })
})
