import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import { findOrCreateConversationRow } from '@/lib/whatsapp/find-or-create-conversation'
import type { MessageTemplate } from '@/types'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  /** The contact's conversation, or null if they have none yet. A
   *  template is the one message Meta delivers to someone who never
   *  wrote, so null is not an error: the send opens the conversation. */
  conversationId: string | null
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + config lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  // The template row carries the header and button components. Without
  // it `sendTemplateMessage` falls back to a body-only payload, and any
  // template with a media header — which is most of the marketing ones —
  // is rejected by Meta with "(#132012) Parameter format does not match
  // format in the created template". Broadcasts have always passed this;
  // automations did not, which is why tag-driven follow-ups never
  // actually delivered.
  let templateRow: MessageTemplate | null = null
  if (input.kind === 'template') {
    const { data: raw } = await db
      .from('message_templates')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('name', input.templateName)
      .eq('language', input.language)
      .maybeSingle()
    if (raw && !isMessageTemplate(raw)) {
      throw new Error(
        'template row is malformed locally. Run "Sync from Meta" in Settings',
      )
    }
    templateRow = (raw as MessageTemplate | null) ?? null
    if (!templateRow) {
      // A name/language pair with no local row means the components
      // cannot be built. Fail loudly here rather than letting Meta
      // return an opaque parameter error per recipient.
      throw new Error(
        `template "${input.templateName}" (${input.language}) is not synced locally. Run "Sync from Meta" in Settings`,
      )
    }
  }

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        template: templateRow ?? undefined,
        params: input.params,
      })
      return r.messageId
    }
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: input.text,
    })
    return r.messageId
  }

  // Same phone-variant retry as /api/whatsapp/send — Meta sandbox and
  // numbers registered with/without a trunk 0 both require this to
  // reliably land a message.
  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // A template to a contact with no conversation opens one, but only
  // now that Meta has taken the message: a send Meta refuses (expired
  // token, paused template) must not leave an empty chat behind for
  // every lead it was meant for. It is the chat the customer's reply
  // lands in, owned like one the webhook opens: by the WhatsApp config
  // owner.
  let conversationId = input.conversationId
  const opensConversation = !conversationId
  if (!conversationId) {
    try {
      conversationId = await findOrCreateConversationRow(
        db,
        input.accountId,
        contact.id,
        config.user_id,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`sent to Meta but opening the conversation failed: ${msg}`)
    }
  }

  // Persist the sent message so it appears in the inbox with a real
  // Meta message id. sender_type='bot' distinguishes automation sends
  // from manual agent sends.
  const content_type = input.kind === 'template' ? 'template' : 'text'
  const content_text = input.kind === 'text' ? input.text : null
  const template_name = input.kind === 'template' ? input.templateName : null
  // A media-header template ships its image, video or document along
  // with the body, but the URL lives on the template row, not on the
  // send. Store it on the message the way sendMessageToConversation
  // does, so the thread shows what the customer received. The engine
  // passes no per-send override, so the row's URL is the one that went
  // out. `header_handle` is no fallback: it's an upload handle, not a URL.
  const media_url =
    templateRow?.header_type && templateRow.header_type !== 'text'
      ? templateRow.header_media_url || null
      : null

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'bot',
    content_type,
    content_text,
    media_url,
    template_name,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  // A template is the bot nudging someone who went quiet (follow-ups,
  // receipt reminders). Bumping last_message_at floated every silent
  // prospect back to the top of the inbox after each nudge, so only the
  // preview changes; the chat keeps its place until someone writes.
  // Text sends answer a live conversation and still move it up. So does
  // a template that just opened the chat: it has no place to keep, and
  // a null last_message_at sorts above every other chat in the inbox.
  const now = new Date().toISOString()
  const movesUp = input.kind === 'text' || opensConversation
  await db
    .from('conversations')
    .update({
      last_message_text:
        input.kind === 'template' ? `[template:${input.templateName}]` : input.text,
      ...(movesUp ? { last_message_at: now } : {}),
      updated_at: now,
    })
    .eq('id', conversationId)

  return { whatsapp_message_id: waMessageId }
}
