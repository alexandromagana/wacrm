import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveQuote, type ReviewReason } from '@/lib/quotes/pricing'
import { buildFinancials, projectionBaseCost } from '@/lib/quotes/finance'
import { buildFolio, buildQuoteFieldValues } from '@/lib/quotes/fields'
import { renderQuotePdf } from '@/lib/quotes/render'
import { uploadServerMedia } from '@/lib/storage/upload-server'
import { engineSendMedia } from '@/lib/flows/meta-send'
import { applyQuoteSentTag } from './lead-status'
import { upsertField, type ReceiptExtraction } from './receipt'

// ============================================================
// Turning a receipt reading into the proposal the customer receives.
//
// Lives in ai/ rather than quotes/ on purpose: quotes/ is deliberately
// free of Meta and Supabase imports so the pricing and the arithmetic
// can be exercised standalone. This module is the seam where those pure
// pieces meet the outside world.
// ============================================================

/** The bucket the inbox already uses for attachments (migration 023). */
const BUCKET = 'chat-media'

/**
 * Panel count of the last proposal actually delivered to this contact.
 * Doubles as the anti-duplicate record and as something useful on the
 * contact card — sales can see what was quoted without opening the PDF.
 */
export const PROPUESTA_FIELD_NAME = 'Propuesta enviada (paneles)'

export type QuoteSendOutcome =
  | { kind: 'sent'; panels: number; folio: string }
  | {
      kind: 'skipped'
      reason: SkipReason
      /** Which review parked it, when `reason` is `needs_review`. The
       *  caller stores it so the question can be re-asked, and answered,
       *  on a later turn. */
      review?: ReviewReason
    }
  | { kind: 'failed'; error: string }

export type SkipReason =
  /** Reading unusable, too few periods, or past the price table. */
  | 'not_quotable'
  /**
   * Priced, but on a window the bot was told to ask about first — a
   * missing current period, or a history that mixes an occupied house
   * with an empty one. The bot asks in text; the document waits — and
   * is released by a later call with `reviewCleared`, once the customer
   * has answered. A hold with no way out is how the customer ends up
   * with a question and never a proposal.
   */
  | 'needs_review'
  /** No readable peso amount, so the comparison cards would be blank. */
  | 'no_financials'
  /** Same tier already delivered — the document would be identical. */
  | 'same_tier'

/** The panel count recorded for a contact, or null if none. */
async function readSentPanels(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<number | null> {
  const { data: field } = await db
    .from('custom_fields')
    .select('id')
    .eq('account_id', accountId)
    .eq('field_name', PROPUESTA_FIELD_NAME)
    .maybeSingle()
  if (!field?.id) return null

  const { data: value } = await db
    .from('contact_custom_values')
    .select('value')
    .eq('contact_id', contactId)
    .eq('custom_field_id', field.id)
    .maybeSingle()

  const parsed = Number(value?.value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Where a freshly-created deal lands: the account's oldest pipeline and
 * that board's first stage, or null when the account has no board yet.
 *
 * "Oldest" rather than "the right one" on purpose — see
 * `recordQuoteOnDeal`, which only creates a deal moments before the
 * "Quote sent" tag fires the automation that moves it to the stage the
 * account actually configured. This picks a valid starting square, not
 * a destination.
 */
async function defaultBoardPosition(
  db: SupabaseClient,
  accountId: string,
): Promise<{ pipelineId: string; stageId: string } | null> {
  const { data: pipeline } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!pipeline?.id) return null

  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipeline.id)
    .order('position', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!stage?.id) return null

  return { pipelineId: pipeline.id as string, stageId: stage.id as string }
}

/**
 * Carry the numbers we just put on the PDF onto the contact's deal, so
 * the board shows the real figure instead of a $0 card that a human has
 * to fill in by hand from the document.
 *
 * The contact's newest open deal wins — the same rule the `move_deal`
 * automation step uses, so the deal this writes to is the deal the
 * "Quote sent → Proposal Sent" automation subsequently moves.
 *
 * A contact with no open deal gets one created here. That used to be a
 * soft no-op, on the reasoning that picking a pipeline and a stage is
 * configuration and belongs to the automation layer — which is sound
 * about the DESTINATION and wrong about the deal itself. Deals are only
 * ever created by a `create_deal` automation step or by hand, so an
 * account without that automation quoted customer after customer with
 * nothing landing on the board: the PDF went out, the panel count and
 * the price were written nowhere a person would look, and the "Quote
 * sent → Proposal Sent" automation had no card to move. A proposal is
 * the point at which a lead has unambiguously become a deal, so the
 * missing card is the bug, not the quoting path overstepping.
 *
 * The starting square is deliberately the account's first pipeline and
 * first stage rather than a guess at the right one: the tag applied
 * immediately after this fires the automation that moves the card
 * wherever the account decided proposals belong. On an account with no
 * board at all there is nothing to create against, and that stays a
 * soft no-op.
 *
 * On an EXISTING deal `currency` is deliberately left alone: the price
 * table is MXN and the account default is MXN, so the value already
 * agrees. A new deal has to state one, and takes the account's default
 * for the same one-currency-per-account reason `create_deal` does.
 *
 * Never throws — a bookkeeping miss must not cost the customer their PDF.
 */
async function recordQuoteOnDeal(
  db: SupabaseClient,
  args: {
    accountId: string
    /** Audit owner for a deal created here, matching `create_deal`. */
    userId: string
    conversationId: string
    contactId: string
    /** Titles the new card the way a person would have. */
    contactName: string | null
    valueMxn: number
    panels: number
    quoteUrl: string
  },
): Promise<void> {
  const {
    accountId,
    userId,
    conversationId,
    contactId,
    contactName,
    valueMxn,
    panels,
    quoteUrl,
  } = args
  try {
    const { data: deal } = await db
      .from('deals')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (deal) {
      const { error } = await db
        .from('deals')
        .update({
          value: valueMxn,
          panel_count: panels,
          quote_url: quoteUrl,
        })
        .eq('id', deal.id)
        .eq('account_id', accountId)
      if (error) throw error
      return
    }

    const board = await defaultBoardPosition(db, accountId)
    if (!board) {
      console.warn(
        `[ai quote-pdf] no pipeline on account ${accountId} — proposal sent with no deal to record it on`,
      )
      return
    }

    const { data: acct } = await db
      .from('accounts')
      .select('default_currency')
      .eq('id', accountId)
      .maybeSingle()

    const { error } = await db.from('deals').insert({
      account_id: accountId,
      user_id: userId,
      pipeline_id: board.pipelineId,
      stage_id: board.stageId,
      contact_id: contactId,
      // The thread the proposal went out on, so the card opens the
      // conversation it came from instead of stranding whoever picks
      // it up on a board with a name and a number.
      conversation_id: conversationId,
      title: contactName?.trim() || 'Propuesta solar',
      value: valueMxn,
      currency: acct?.default_currency ?? 'MXN',
      panel_count: panels,
      quote_url: quoteUrl,
      status: 'open',
    })
    if (error) throw error
  } catch (err) {
    console.error('[ai quote-pdf] failed to record quote on deal:', err)
  }
}

/**
 * Render the branded proposal for a receipt reading and send it as a
 * WhatsApp document.
 *
 * NEVER throws. The proposal is an enhancement to a reply the customer
 * has already received; a template that failed to load or a storage
 * hiccup must not take the conversation with it. Every outcome is
 * returned so the caller can log it.
 *
 * Skips silently when the reading cannot carry a document:
 *   - not quotable (unreadable, one period only, or above the table)
 *   - no peso amount, which would leave the comparison cards empty
 *   - the same tier was already delivered, so the PDF would be a
 *     byte-for-byte duplicate down to the folio
 */
export async function sendQuoteProposal(
  db: SupabaseClient,
  args: {
    accountId: string
    /** Audit owner for the outbound send and any created custom field. */
    userId: string
    conversationId: string
    contactId: string
    extraction: ReceiptExtraction
    /**
     * Release a document this reading's own numbers would otherwise
     * hold back. Set only once the customer has answered the question
     * the bot asked about that window ("es mi consumo normal") — the
     * window is still odd on paper, and the person who lives there has
     * now said it is theirs.
     *
     * Narrow on purpose: it lifts `needs_review` and nothing else. An
     * unreadable bill, a project past the price table, or a proposal
     * that would print blank comparison cards are not opinions a
     * customer can overrule.
     */
    reviewCleared?: boolean
  },
): Promise<QuoteSendOutcome> {
  const {
    accountId,
    userId,
    conversationId,
    contactId,
    extraction,
    reviewCleared = false,
  } = args

  try {
    const quote = resolveQuote(
      extraction.promedio_bimestral_kwh,
      extraction.cantidad_periodos_usados,
      {
        includesCurrentPeriod: extraction.incluye_periodo_actual,
        periods: extraction.periodos_promediados_kwh,
      },
    )
    // Reported apart from `not_quotable` because it is the one skip a
    // human should act on: the numbers priced fine, we are holding the
    // document until the customer answers the bot's question.
    if (quote.kind === 'needs_review' && !reviewCleared) {
      return { kind: 'skipped', reason: 'needs_review', review: quote.reason }
    }
    if (quote.kind !== 'ok' && quote.kind !== 'needs_review') {
      return { kind: 'skipped', reason: 'not_quotable' }
    }

    const financials = buildFinancials({
      costoBimestralMxn: projectionBaseCost({
        costoPeriodoMxn: extraction.costo_periodo_mxn,
        historialImporteMxn: extraction.historial_bimestres_importe_mxn,
      }),
      tier: quote.tier,
    })
    // Half the document is the "with panels vs without" comparison. A
    // proposal with those cards blank reads as broken, so we would
    // rather send nothing and let the bot quote in text.
    if (!financials) return { kind: 'skipped', reason: 'no_financials' }

    const alreadySent = await readSentPanels(db, accountId, contactId)
    if (alreadySent === quote.tier.panels) {
      return { kind: 'skipped', reason: 'same_tier' }
    }

    const { data: contact } = await db
      .from('contacts')
      .select('name')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()

    const now = new Date()
    // Seeded on the contact AND the system being quoted: re-sending the
    // same proposal reproduces the folio the customer already has, while
    // a genuinely different system gets its own — two PDFs with the same
    // folio and different prices is the version of this the customer
    // notices.
    const folio = buildFolio(now, `${contactId}:${quote.tier.panels}`)
    const { bytes } = await renderQuotePdf(
      buildQuoteFieldValues({
        nombre: (contact?.name as string | null) ?? null,
        tier: quote.tier,
        folio,
        now,
        financials,
      }),
    )

    // Meta fetches the link itself, so the object has to be public and
    // still there when it does — uploaded before the send, never after.
    const filename = `Propuesta ${folio}.pdf`
    const { publicUrl } = await uploadServerMedia({
      db,
      bucket: BUCKET,
      accountId,
      bytes,
      fileName: filename,
      contentType: 'application/pdf',
    })

    await engineSendMedia({
      accountId,
      userId,
      conversationId,
      contactId,
      kind: 'document',
      link: publicUrl,
      // No caption: the bot's own message went out moments earlier and
      // already states the numbers.
      filename,
      aiGenerated: true,
    })

    // Only after the send lands — a failed delivery must stay
    // retryable on the customer's next receipt.
    await upsertField(db, {
      accountId,
      userId,
      contactId,
      fieldName: PROPUESTA_FIELD_NAME,
      fieldType: 'number',
      value: String(quote.tier.panels),
      overwrite: true,
    })

    // Deal first, tag second, and the order is load-bearing: applying
    // the tag fires the "Quote sent → Proposal Sent" automation, which
    // moves this very deal. Writing the figures beforehand means the
    // card is already correct the moment it lands in the new stage.
    await recordQuoteOnDeal(db, {
      accountId,
      userId,
      conversationId,
      contactId,
      contactName: (contact?.name as string | null) ?? null,
      valueMxn: quote.tier.priceMxn,
      panels: quote.tier.panels,
      quoteUrl: publicUrl,
    })

    // "Quote sent" belongs to the document actually going out, not to
    // the bot mentioning a price in chat — that distinction is what
    // makes the 48h follow-up sequence trustworthy. The `same_tier`
    // guard above already returned for a re-send of an identical
    // proposal, so this runs once per genuinely new quote.
    await applyQuoteSentTag(db, { accountId, userId, contactId })

    return { kind: 'sent', panels: quote.tier.panels, folio }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ai quote-pdf] proposal send failed:', err)
    return { kind: 'failed', error: message }
  }
}
