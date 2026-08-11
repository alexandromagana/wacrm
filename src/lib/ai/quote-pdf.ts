import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveQuote } from '@/lib/quotes/pricing'
import { buildFinancials, projectionBaseCost } from '@/lib/quotes/finance'
import { buildFolio, buildQuoteFieldValues } from '@/lib/quotes/fields'
import { renderQuotePdf } from '@/lib/quotes/render'
import { uploadServerMedia } from '@/lib/storage/upload-server'
import { engineSendMedia } from '@/lib/flows/meta-send'
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
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'failed'; error: string }

export type SkipReason =
  /** Reading unusable, too few periods, or past the price table. */
  | 'not_quotable'
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
  },
): Promise<QuoteSendOutcome> {
  const { accountId, userId, conversationId, contactId, extraction } = args

  try {
    const quote = resolveQuote(
      extraction.promedio_bimestral_kwh,
      extraction.cantidad_periodos_usados,
    )
    if (quote.kind !== 'ok') return { kind: 'skipped', reason: 'not_quotable' }

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
    // Seeded on the contact, so a re-quote carries the folio the
    // customer already has written down.
    const folio = buildFolio(now, contactId)
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

    return { kind: 'sent', panels: quote.tier.panels, folio }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ai quote-pdf] proposal send failed:', err)
    return { kind: 'failed', error: message }
  }
}
