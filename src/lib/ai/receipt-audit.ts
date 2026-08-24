import { supabaseAdmin } from './admin-client'
import type { AiProvider } from './types'
import type { ReceiptExtraction } from './receipt'

// ============================================================
// What the vision model actually said, kept so a bad quote can be
// explained after the fact.
//
// The reason this exists: a proposal went out sized 8 paneles instead of
// 6 because the model picked the wrong rows out of a twelve-row historial
// table. Every number downstream was computed correctly from what it
// reported, and what it reported was gone the moment the request ended.
// The bug could be reasoned about from the printed bill and fixed, but
// never reproduced — and "we think it misread a row" is a much weaker
// position than "here is the row it misread".
//
// Deliberately its own module, like `usage.ts`: the logging must not be
// something `receipt.ts` can fail at. Every function here swallows its
// own errors and returns void.
// ============================================================

/** Which surface asked for the read. */
export type ReceiptReadSource = 'auto_reply' | 'cotizador'

export interface LogReceiptReadingArgs {
  accountId: string
  /** Null from the Cotizador, which has no conversation behind it. */
  conversationId?: string | null
  contactId?: string | null
  source: ReceiptReadSource
  provider: AiProvider
  model: string
  /** Exactly what the provider returned, unparsed. Null when it returned
   *  nothing — the attempt is still worth a row. */
  rawResponse: string | null
  /** What the raw response became, or null when it would not parse. */
  extraction: ReceiptExtraction | null
  /** WhatsApp media ids behind the read; empty for a browser upload. */
  mediaIds?: readonly string[]
}

/**
 * How much of a response we are willing to keep.
 *
 * The extraction prompt asks for a JSON object of twelve fields, which
 * runs a few hundred characters. Anything approaching this cap is a
 * model that ignored the format and started narrating — worth keeping
 * the head of, since that IS the finding, but not worth storing in full
 * on every row forever.
 */
const MAX_RAW_CHARS = 20_000

/**
 * Append one row to `ai_receipt_readings`.
 *
 * Writes through the service-role client rather than the caller's,
 * because the two callers hold different ones — the webhook has the
 * admin client already, the Cotizador route holds an RLS-scoped SSR
 * client that the table has no INSERT policy for. Taking the decision
 * here means neither caller can get it wrong, and the log cannot quietly
 * stop recording the Cotizador's reads.
 *
 * NEVER throws. A forensic log that can fail a customer's quote is worse
 * than no forensic log: this is fired and forgotten at both call sites,
 * so a rejection here would surface as an unhandled promise rejection
 * rather than a caught error.
 */
export async function logReceiptReading(
  args: LogReceiptReadingArgs,
): Promise<void> {
  try {
    const { extraction } = args
    const raw = args.rawResponse
    const { error } = await supabaseAdmin()
      .from('ai_receipt_readings')
      .insert({
        account_id: args.accountId,
        conversation_id: args.conversationId ?? null,
        contact_id: args.contactId ?? null,
        source: args.source,
        provider: args.provider,
        model: args.model,
        raw_response: raw != null ? raw.slice(0, MAX_RAW_CHARS) : null,
        parsed: extraction ?? null,
        promedio_kwh: extraction?.promedio_bimestral_kwh ?? null,
        media_ids: args.mediaIds ?? [],
      })
    if (error) throw error
  } catch (err) {
    console.error('[ai receipt-audit] failed to log a reading:', err)
  }
}
