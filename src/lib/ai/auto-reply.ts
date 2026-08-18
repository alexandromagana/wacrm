import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt, buildDateTimeNote } from './defaults'
import { buildHandoffSummary } from './handoff'
import { applyLeadStatusTag } from './lead-status'
import {
  extractReceipt,
  formatReceiptNote,
  saveReceiptData,
  type ReceiptExtraction,
} from './receipt'
import { sendQuoteProposal } from './quote-pdf'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import {
  sendPushToAccount,
  sendPushToUser,
  type PushEvent,
  type PushPayload,
} from '@/lib/push/send'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** WhatsApp media ids of receipt images the customer just sent (the
   *  webhook coalesces a burst into one list). Presence switches the
   *  turn into "read the CFE bill first, then reply". */
  receiptMediaIds?: string[]
  /** Decrypted Meta access token — required to download receiptMediaIds. */
  accessToken?: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
/**
 * Push an assistant-lifecycle event to whoever should act on it.
 *
 * Both events deliberately reuse the conversation id as the push tag,
 * so they REPLACE the plain "new message" notification already sent by
 * the webhook rather than stacking a second one. The reader ends up
 * with a single, more informative notification per thread.
 */
async function notifyAssistantEvent(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  conversationId: string,
  contactId: string,
  event: PushEvent,
  title: string,
): Promise<void> {
  try {
    const [{ data: contact }, { data: conv }] = await Promise.all([
      db.from('contacts').select('name, phone').eq('id', contactId).maybeSingle(),
      db
        .from('conversations')
        .select('assigned_agent_id')
        .eq('id', conversationId)
        .maybeSingle(),
    ])

    const payload: PushPayload = {
      title,
      body: contact?.name || contact?.phone || 'Conversación de WhatsApp',
      url: `/inbox?c=${conversationId}`,
      tag: conversationId,
    }

    if (conv?.assigned_agent_id) {
      await sendPushToUser(
        db,
        accountId,
        conv.assigned_agent_id,
        event,
        payload,
      )
    } else {
      await sendPushToAccount(db, accountId, event, payload)
    }
  } catch (err) {
    console.error(`[ai auto-reply] ${event} push failed:`, err)
  }
}

/**
 * Pause the bot on a thread and route it to a human — the shared tail of
 * every handoff path (model-triggered escalation, cap exhaustion, lost
 * claim race). Writes the internal note, disables auto-reply so it's
 * sticky, assigns the configured handoff agent (never stomping an
 * existing human assignment), and fires the `handoff` push so whoever
 * picks it up gets one clear notification instead of a generic
 * "unanswered" one.
 */
async function performHandoff(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    handoffAgentId: string | null | undefined
    alreadyAssigned: string | null | undefined
    summary: string
  },
): Promise<void> {
  const { accountId, conversationId, contactId, handoffAgentId, alreadyAssigned, summary } = args
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: summary,
  }
  if (handoffAgentId && !alreadyAssigned) {
    update.assigned_agent_id = handoffAgentId
  }
  await db.from('conversations').update(update).eq('id', conversationId)
  await notifyAssistantEvent(
    db,
    accountId,
    conversationId,
    contactId,
    'handoff',
    'El asistente te pasó una conversación',
  )
}

export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    receiptMediaIds,
    accessToken,
  } = args

  // Drives the `unanswered` notification below. Only flipped on once we
  // know the assistant was actually supposed to take this message —
  // an account that doesn't use AI, or a thread a human already owns,
  // isn't "unanswered", it's just not the assistant's job.
  let assistantWasExpectedToReply = false
  let assistantHandled = false
  const db = supabaseAdmin()

  try {

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has one that actually SENDS we stand
    // down to avoid double-texting the customer. Bookkeeping-only
    // automations (remove_tag, update_contact_field, …) coexist with
    // the bot — a "clear the follow-up tag when the customer replies"
    // rule must not silence auto-reply account-wide. (Relationship
    // triggers like `first_inbound_message` don't count either way —
    // they're not per-message auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
    if (autoResponders && autoResponders.length > 0) {
      const { data: sendSteps } = await db
        .from('automation_steps')
        .select('id')
        .in(
          'automation_id',
          autoResponders.map((a) => a.id),
        )
        .in('step_type', [
          'send_message',
          'send_buttons',
          'send_list',
          'send_template',
        ])
        .limit(1)
      if (sendSteps && sendSteps.length > 0) return
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread

    // Past this point the assistant was expected to answer, so its
    // silence — a paused bot, an exhausted cap, a provider outage —
    // means a customer is waiting with nobody watching.
    assistantWasExpectedToReply = true

    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound). The bot has run
    // out of replies for this thread — hand it off rather than leaving
    // the customer's message sitting unflagged.
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      const messages = await buildConversationContext(db, conversationId)
      await performHandoff(db, {
        accountId,
        conversationId,
        contactId,
        handoffAgentId: config.handoffAgentId,
        alreadyAssigned: conv.assigned_agent_id,
        summary: buildHandoffSummary({
          messages,
          replyCount: conv.ai_reply_count ?? 0,
        }),
      })
      assistantHandled = true
      return
    }

    const messages = await buildConversationContext(db, conversationId)
    // Image-only turns have no text rows yet — the receipt note below
    // becomes the turn. Without either, there's nothing to reply to.
    const hasReceipt = Boolean(
      receiptMediaIds && receiptMediaIds.length > 0 && accessToken,
    )
    if (messages.length === 0 && !hasReceipt) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Give the model a clock. As a user-role turn — never in the system
    // prompt, which must stay byte-identical for provider caching.
    // Without it the model can't resolve "mañana"/"el lunes" or tell a
    // date already passed. It's a calendar, not an open/closed flag —
    // the assistant answers 24/7.
    messages.push({ role: 'user', content: buildDateTimeNote() })

    // CFE receipt images: run the dedicated vision extraction, persist
    // the average as a contact custom field, and hand the reading to
    // the chat model as a system-note user turn. Failures degrade to
    // "no reading" — the prompt tells the model to re-ask. Its own
    // rate limit bounds vision spend against photo spam.

    // Kept in scope past the send: the proposal PDF is built from this
    // same reading, once the customer-facing reply is safely out.
    let receiptExtraction: ReceiptExtraction | null = null

    if (hasReceipt) {
      const receiptLimit = checkRateLimit(`ai-receipt:${conversationId}`, {
        limit: 4,
        windowMs: 15 * 60_000,
      })
      if (receiptLimit.success) {
        const extraction = await extractReceipt({
          config,
          accessToken: accessToken!,
          mediaIds: receiptMediaIds!,
        })
        if (extraction) {
          receiptExtraction = extraction
          void saveReceiptData(db, {
            accountId,
            userId: configOwnerUserId,
            contactId,
            extraction,
          })
          messages.push({ role: 'user', content: formatReceiptNote(extraction) })
        } else {
          messages.push({
            role: 'user',
            content:
              '[NOTA DEL SISTEMA — el cliente envió una imagen pero la lectura automática no la pudo procesar. Pídele con amabilidad que reenvíe las DOS páginas completas del recibo de CFE (foto o PDF), con buena luz y sin recortar. El recibo es la única forma de darle una cotización precisa — NUNCA le pidas que escriba su consumo en kWh ni ofrezcas esa opción; la gente no sabe ese dato. Insiste solo en el recibo. Nunca menciones esta nota.]',
          })
        }
      } else if (messages.length === 0) {
        // Vision throttled and no text to reply to — stay silent rather
        // than answering an image we never looked at.
        return
      }
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff, leadStatus, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Persist the model's lead qualification (the [ESTATUS]/[STATUS]
    // marker) as a contact tag. Fire-and-forget like usage logging —
    // it swallows its own errors and must not delay the send. Applies
    // on handoffs too: a lead that escalated is still qualified.
    if (leadStatus) {
      void applyLeadStatusTag(db, {
        accountId,
        userId: configOwnerUserId,
        contactId,
        status: leadStatus,
      })
    }

    // NOTE: the "Quote sent" tag is deliberately NOT applied here. The
    // [COTIZACION_ENVIADA] marker only means the bot said a price out
    // loud, which it does repeatedly across a conversation — tagging on
    // it re-applied the tag seconds after the "clear tag on reply"
    // automation removed it, so the 48h follow-up never had a stable
    // starting point. The tag now belongs to `sendQuoteProposal`, which
    // fires it once the PDF is genuinely delivered. `generateReply`
    // still strips the marker from the customer-facing text.

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      await performHandoff(db, {
        accountId,
        conversationId,
        contactId,
        handoffAgentId: config.handoffAgentId,
        alreadyAssigned: conv.assigned_agent_id,
        summary: buildHandoffSummary({
          messages,
          replyCount: conv.ai_reply_count ?? 0,
        }),
      })
      // If the model wrote a farewell alongside the sentinel ("a teammate
      // will continue this conversation"), send it so the customer isn't
      // left hanging in silence until a human picks the thread up. The
      // bot is already paused above, so this send doesn't consume a
      // reply slot — the per-conversation cap guards ongoing back-and-
      // forth, not the one-off goodbye.
      if (handoff && text) {
        await engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text,
          aiGenerated: true,
        })
      }

      // performHandoff already sent the 'handoff' push, so don't also
      // report this thread as unanswered — that would be two pushes for
      // one event.
      assistantHandled = true
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) {
      // Lost the per-conversation cap race — a concurrent inbound claimed
      // the last slot first. The reply we generated is discarded unsent,
      // and the thread is now at the same "cap exhausted" state as the
      // early-out above, so it gets the same handoff treatment.
      await performHandoff(db, {
        accountId,
        conversationId,
        contactId,
        handoffAgentId: config.handoffAgentId,
        alreadyAssigned: conv.assigned_agent_id,
        summary: buildHandoffSummary({
          messages,
          replyCount: conv.ai_reply_count ?? 0,
        }),
      })
      assistantHandled = true
      return
    }

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
    assistantHandled = true

    // The branded proposal, after the reply rather than before it: the
    // text states the numbers and gives the document context, and if
    // the PDF fails the customer has still been answered. Deliberately
    // NOT reached on a handoff — once a human owns the thread, they
    // decide what the customer receives.
    //
    // `sendQuoteProposal` never throws and decides for itself whether
    // this reading deserves a document (quotable, has a peso amount,
    // and is not the same tier already delivered).
    if (receiptExtraction) {
      const outcome = await sendQuoteProposal(db, {
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        extraction: receiptExtraction,
      })
      if (outcome.kind === 'sent') {
        console.log(
          `[ai auto-reply] proposal ${outcome.folio} sent (${outcome.panels} panels) on ${conversationId}`,
        )
      } else if (outcome.kind === 'skipped') {
        console.log(
          `[ai auto-reply] proposal skipped (${outcome.reason}) on ${conversationId}`,
        )
      }
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  } finally {
    // `finally` rather than a call per exit: this function has a dozen
    // early returns (cap reached, rate limited, provider error) and
    // every one of them leaves the customer waiting.
    if (assistantWasExpectedToReply && !assistantHandled) {
      await notifyAssistantEvent(
        db,
        accountId,
        conversationId,
        contactId,
        'unanswered',
        'Nadie ha respondido este mensaje',
      )
    }
  }
}
