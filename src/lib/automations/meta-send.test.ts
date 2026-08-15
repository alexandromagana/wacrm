import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(),
  sendTextMessage: vi.fn(),
  decrypt: vi.fn(),
  supabaseAdmin: vi.fn(),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
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
vi.mock('./admin-client', () => ({ supabaseAdmin: h.supabaseAdmin }))

import { engineSendTemplate } from './meta-send'

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

/**
 * Fake covering the tables `sendViaMeta` touches. `templateRow` is what
 * the message_templates lookup resolves to — null models a template
 * that exists in Meta but was never synced locally.
 */
function fakeDb(templateRow: unknown = TEMPLATE_ROW) {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {
      select: () => c,
      update: () => c,
      insert: () => c,
      eq: () => c,
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
          data: { phone_number_id: 'pn-1', access_token: 'cipher' },
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
  h.decrypt.mockReturnValue('token')
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' })
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
