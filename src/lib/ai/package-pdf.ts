import type { SupabaseClient } from '@supabase/supabase-js'
import type { SolarTier } from '@/lib/quotes/pricing'
import { buildFolio } from '@/lib/quotes/fields'
import { buildPackageFieldValues } from '@/lib/quotes/package-fields'
import { renderPackagePdf } from '@/lib/quotes/render'
import { uploadServerMedia } from '@/lib/storage/upload-server'
import { engineSendMedia } from '@/lib/flows/meta-send'
import { applyQuoteSentTag } from './lead-status'
import { upsertField } from './receipt'
import { readContactNumberField, recordQuoteOnDeal } from './quote-pdf'

// ============================================================
// Sending the package sheet: the one-page, price-only quote for a
// customer who asked for a number of panels without a bill.
//
// The mirror of `sendQuoteProposal` for the other way in. Same bucket,
// same send, same bookkeeping afterwards — a package sheet is a quote
// the customer can act on, so it lands on the board and starts the
// follow-up exactly as a full proposal does.
// ============================================================

/** The bucket the proposal uses too (migration 023). */
const BUCKET = 'chat-media'

/**
 * Panel count of the last package sheet sent to this contact. Kept apart
 * from `PROPUESTA_FIELD_NAME` on purpose: sharing it would make a later
 * bill-based proposal for the same size look like a duplicate and never
 * go out, and that proposal is the better document.
 */
export const PAQUETE_FIELD_NAME = 'Hoja de paquete enviada (paneles)'

/** The package whose sheet this contact last received, or null. */
export function readSentPackagePanels(
  db: SupabaseClient,
  args: { accountId: string; contactId: string },
): Promise<number | null> {
  return readContactNumberField(
    db,
    args.accountId,
    args.contactId,
    PAQUETE_FIELD_NAME,
  )
}

export type PackageSendOutcome =
  | { kind: 'sent'; panels: number; folio: string }
  | { kind: 'failed'; error: string }

/**
 * Render the package sheet for `tier` and send it as a WhatsApp document.
 *
 * NEVER throws, like `sendQuoteProposal`: the customer already has the
 * reply with the price in it, and a storage hiccup must not take the
 * conversation down with the document.
 */
export async function sendPackageSheet(
  db: SupabaseClient,
  args: {
    accountId: string
    /** Audit owner for the outbound send and any created custom field. */
    userId: string
    conversationId: string
    contactId: string
    tier: SolarTier
  },
): Promise<PackageSendOutcome> {
  const { accountId, userId, conversationId, contactId, tier } = args
  try {
    const { data: contact } = await db
      .from('contacts')
      .select('name')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()

    const now = new Date()
    // Seeded apart from the proposal's `${contactId}:${panels}`: the
    // sheet and a later bill-based proposal for the same size are two
    // different documents and must not share a folio.
    const folio = buildFolio(now, `${contactId}:paquete:${tier.panels}`)
    const { bytes } = await renderPackagePdf(
      buildPackageFieldValues({ tier, folio, now }),
    )

    // Uploaded before the send, never after: Meta fetches the link itself.
    const filename = `Cotización ${folio}.pdf`
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
      // No caption: the bot's message just before it states the price.
      filename,
      aiGenerated: true,
    })

    await upsertField(db, {
      accountId,
      userId,
      contactId,
      fieldName: PAQUETE_FIELD_NAME,
      fieldType: 'number',
      value: String(tier.panels),
      overwrite: true,
    })

    // Deal first, tag second — the tag fires the automation that moves
    // this very deal, so the card has to carry the figures already.
    await recordQuoteOnDeal(db, {
      accountId,
      userId,
      conversationId,
      contactId,
      contactName: (contact?.name as string | null) ?? null,
      valueMxn: tier.priceMxn,
      panels: tier.panels,
      quoteUrl: publicUrl,
    })
    await applyQuoteSentTag(db, { accountId, userId, contactId })

    return { kind: 'sent', panels: tier.panels, folio }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ai package-pdf] package sheet send failed:', err)
    return { kind: 'failed', error: message }
  }
}
