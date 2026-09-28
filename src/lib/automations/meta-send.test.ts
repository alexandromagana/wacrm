import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(),
  sendTextMessage: vi.fn(),
  decrypt: vi.fn(),
  supabaseAdmin: vi.fn(),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
  findOrCreateConversationRow: vi.fn(),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: h.sendTemplateMessage,
  sendTextMessage: h.sendTextMessage,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: h.decrypt }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendInteractiveButtons: h.engineSendInteractiveButtons,
  engineSendInteractiveList: h.engineSendInteractiveList,
}))
vi.mock('@/lib/whatsapp/find-or-create-conversation', () => ({
  findOrCreateConversationRow: h.findOrCreateConversationRow,
}))
vi.mock('./admin-client', () => ({ supabaseAdmin: h.supabaseAdmin }))

import { engineSendTemplate, engineSendText } from './meta-send'

/** A row that satisfies `isMessageTemplate` and carries a media header —
 *  the case Meta rejects when the components are not built from it. */
const TEMPLATE_ROW = {
  id: 'tpl-1',
  user_id: 'user-1',
  name: 'seguimiento_coti',
  language: 'es_MX',
  body_text: 'Tú ya tienes tu propuesta en la mano',
  header_type: 'image',
  header_media_url: 'https://storage.test/header.jpg',
  buttons: [{ type: 'QUICK_REPLY', text: '¡Nada, vamos!' }],
}

/** Every `.update()` payload with the `.eq()` filters that target it,
 *  by table, for the current test. */
let updates: Array<{
  table: string
  payload: Record<string, unknown>
  eq: Record<string, unknown>
}> = []
/** Every `.insert()` row, by table, for the current test. */
let inserts: Array<{ table: string; payload: Record<string, unknown> }> = []

/**
 * Fake covering the tables `sendViaMeta` touches. `templateRow` is what
 * the message_templates lookup resolves to — null models a template
 * that exists in Meta but was never synced locally.
 */
function fakeDb(templateRow: unknown = TEMPLATE_ROW) {
  const chain = (table: string) => {
    let update: (typeof updates)[number] | null = null
    const c: Record<string, unknown> = {
      select: () => c,
      update: (payload: Record<string, unknown>) => {
        update = { table, payload, eq: {} }
        updates.push(update)
        return c
      },
      insert: (payload: Record<string, unknown>) => {
        inserts.push({ table, payload })
        return c
      },
      eq: (column: string, value: unknown) => {
        if (update) update.eq[column] = value
        return c
      },
      maybeSingle: () => {
        if (table === 'contacts') {
          return Promise.resolve({ data: { id: 'contact-1', phone: '+5219987586975' }, error: null })
        }
        if (table === 'message_templates') {
          return Promise.resolve({ data: templateRow, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
      single: () =>
        Promise.resolve({
          data: { phone_number_id: 'pn-1', access_token: 'cipher', user_id: 'owner-1' },
          error: null,
        }),
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    }
    return c
  }
  return { from: (table: string) => chain(table) }
}

const ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  templateName: 'seguimiento_coti',
  language: 'es_MX',
}

beforeEach(() => {
  vi.clearAllMocks()
  updates = []
  inserts = []
  h.decrypt.mockReturnValue('token')
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' })
  h.sendTextMessage.mockResolvedValue({ messageId: 'wamid.2' })
  h.findOrCreateConversationRow.mockResolvedValue('conv-new')
  h.supabaseAdmin.mockReturnValue(fakeDb())
})

describe('engineSendTemplate — template components', () => {
  it('passes the template row through to Meta', async () => {
    // The regression this guards: without `template`, sendTemplateMessage
    // falls back to a body-only payload and Meta rejects any template
    // with a media header — "(#132012) Parameter format does not match
    // format in the created template". Broadcasts always passed it;
    // automations did not, so tag-driven follow-ups never delivered.
    await engineSendTemplate(ARGS)

    expect(h.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'seguimiento_coti',
        language: 'es_MX',
        template: TEMPLATE_ROW,
      }),
    )
  })

  it('never calls Meta with an undefined template', async () => {
    await engineSendTemplate(ARGS)
    const arg = h.sendTemplateMessage.mock.calls[0][0]
    expect(arg.template).toBeDefined()
  })

  it('refuses to send when the template is not synced locally', async () => {
    // Failing here names the problem and points at "Sync from Meta",
    // instead of letting every recipient come back with the same
    // opaque parameter error from Meta.
    h.supabaseAdmin.mockReturnValue(fakeDb(null))

    await expect(engineSendTemplate(ARGS)).rejects.toThrow(/not synced locally/)
    expect(h.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('refuses to send when the local row is malformed', async () => {
    h.supabaseAdmin.mockReturnValue(fakeDb({ id: 'tpl-1' }))

    await expect(engineSendTemplate(ARGS)).rejects.toThrow(/malformed/)
    expect(h.sendTemplateMessage).not.toHaveBeenCalled()
  })
})

describe('engineSendTemplate — the stored message', () => {
  const messageInsert = () => inserts.find((i) => i.table === 'messages')?.payload

  it('stores the header image the customer received', async () => {
    // The image goes out with the template but lives on the template
    // row, so the stored message had no record of what was sent.
    // Same resolution as sendMessageToConversation.
    await engineSendTemplate(ARGS)

    expect(messageInsert()).toMatchObject({
      content_type: 'template',
      template_name: 'seguimiento_coti',
      media_url: 'https://storage.test/header.jpg',
    })
  })

  it('stores no media for a text header', async () => {
    // A text header is the body's first line. A URL left on the row
    // from an earlier media header was never sent, so it isn't stored.
    h.supabaseAdmin.mockReturnValue(fakeDb({ ...TEMPLATE_ROW, header_type: 'text' }))

    await engineSendTemplate(ARGS)

    expect(messageInsert()).toMatchObject({ media_url: null })
  })
})

describe('conversation ordering', () => {
  const conversationUpdate = () =>
    updates.find((u) => u.table === 'conversations')?.payload

  it('keeps a chat in place when the bot sends a template', async () => {
    // Follow-ups and receipt reminders go to people who stopped
    // answering; bumping last_message_at floated every one of them back
    // to the top of the inbox.
    await engineSendTemplate(ARGS)

    expect(conversationUpdate()).toMatchObject({
      last_message_text: '[template:seguimiento_coti]',
    })
    expect(conversationUpdate()).not.toHaveProperty('last_message_at')
  })

  it('still moves a chat up for a text reply', async () => {
    await engineSendText({
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      text: 'Hola',
    })

    expect(conversationUpdate()).toMatchObject({ last_message_text: 'Hola' })
    expect(conversationUpdate()).toHaveProperty('last_message_at')
  })
})

describe('engineSendTemplate — a contact with no conversation', () => {
  // A Facebook lead who never wrote: the template is what opens the chat.
  const NO_CONVERSATION = { ...ARGS, conversationId: null }
  const messageInsert = () => inserts.find((i) => i.table === 'messages')?.payload

  it('opens the conversation and records the message in it', async () => {
    await engineSendTemplate(NO_CONVERSATION)

    // Owned by the WhatsApp config owner, as the webhook would own it.
    expect(h.findOrCreateConversationRow).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'contact-1',
      'owner-1',
    )
    expect(messageInsert()).toMatchObject({
      conversation_id: 'conv-new',
      sender_type: 'bot',
      content_type: 'template',
      template_name: 'seguimiento_coti',
      message_id: 'wamid.1',
      status: 'sent',
    })
  })

  it('opens it only after Meta accepted the message', async () => {
    await engineSendTemplate(NO_CONVERSATION)

    const [sent] = h.sendTemplateMessage.mock.invocationCallOrder
    const [opened] = h.findOrCreateConversationRow.mock.invocationCallOrder
    expect(sent).toBeLessThan(opened)
  })

  it('gives the chat it opened a place in the inbox', async () => {
    // A null last_message_at sorts first, so a lead nobody has heard
    // from would sit above every live chat until they wrote.
    await engineSendTemplate(NO_CONVERSATION)

    const update = updates.find((u) => u.table === 'conversations')
    expect(update?.eq).toEqual({ id: 'conv-new' })
    expect(update?.payload).toMatchObject({
      last_message_text: '[template:seguimiento_coti]',
    })
    expect(update?.payload).toHaveProperty('last_message_at')
  })

  it('opens nothing when Meta refuses the send', async () => {
    h.sendTemplateMessage.mockRejectedValue(
      new Error('(#132001) Template name does not exist in the translation'),
    )

    await expect(engineSendTemplate(NO_CONVERSATION)).rejects.toThrow(/132001/)
    expect(h.findOrCreateConversationRow).not.toHaveBeenCalled()
    expect(inserts).toHaveLength(0)
  })

  it('says the message went out when the conversation could not be opened', async () => {
    h.findOrCreateConversationRow.mockRejectedValue(new Error('Failed to create conversation'))

    await expect(engineSendTemplate(NO_CONVERSATION)).rejects.toThrow(
      'sent to Meta but opening the conversation failed: Failed to create conversation',
    )
    expect(inserts).toHaveLength(0)
  })

  it('uses the conversation it is given without looking for another', async () => {
    await engineSendTemplate(ARGS)

    expect(h.findOrCreateConversationRow).not.toHaveBeenCalled()
    expect(messageInsert()).toMatchObject({ conversation_id: 'conv-1' })
  })
})
