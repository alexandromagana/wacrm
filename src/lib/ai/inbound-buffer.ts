import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Inbound burst coalescing ("message buffer").
//
// Customers type in bursts — "ahí está" + "ya te mandé mi recibo" three
// seconds apart, or two receipt pages back-to-back. Each inbound
// arrives as its own webhook delivery, and replying per-delivery made
// the bot double-text. Instead every AI-eligible delivery sleeps a
// debounce, then asks: am I still the NEWEST customer message in this
// conversation? Only the winner dispatches one reply over the whole
// burst; superseded siblings stand down (their content still reaches
// the model via conversation context).
// ============================================================

const DEFAULT_DEBOUNCE_MS = 8_000

/** How far back a burst can reach for receipt media. Covers "page 1,
 *  then page 2 three minutes later while they find it". */
const MEDIA_LOOKBACK_MS = 15 * 60_000

/** Only bursts that actually contain FRESH media trigger a (re-)read —
 *  a "gracias" text minutes after the receipt must not re-extract. */
const FRESH_MEDIA_WINDOW_MS = 90_000

/** Debounce before the newest-message claim. Tunable via
 *  `AI_REPLY_DEBOUNCE_MS`; 0 disables the sleep (tests/local). */
export function inboundDebounceMs(): number {
  const raw = Number(process.env.AI_REPLY_DEBOUNCE_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEBOUNCE_MS
}

export interface BurstResolution {
  /** A newer customer message arrived during the debounce — its own
   *  delivery owns the reply; this one must not dispatch. */
  superseded: boolean
  /** WhatsApp media ids of receipt candidates in this burst (oldest
   *  first, page 1 before page 2). Empty when the burst has no fresh
   *  media. */
  receiptMediaIds: string[]
}

/**
 * Decide whether this delivery owns the burst's reply, and which
 * receipt media the reply should read. Runs AFTER the debounce sleep.
 *
 * The claim compares Meta message ids on the newest customer row — both
 * racers run the identical query, so they see the same winner even when
 * timestamps tie (Meta stamps whole seconds and two photos often share
 * one).
 */
export async function resolveInboundBurst(
  db: SupabaseClient,
  args: { conversationId: string; metaMessageId: string },
): Promise<BurstResolution> {
  const { conversationId, metaMessageId } = args

  const { data: newest, error: newestErr } = await db
    .from('messages')
    .select('message_id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .in('content_type', ['text', 'image', 'document'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (newestErr) {
    // Fail open: better an occasional double-reply than a silent bot.
    console.error('[inbound-buffer] newest lookup failed:', newestErr)
    return { superseded: false, receiptMediaIds: [] }
  }
  if (newest && newest.message_id !== metaMessageId) {
    return { superseded: true, receiptMediaIds: [] }
  }

  const { data: media, error: mediaErr } = await db
    .from('messages')
    .select('media_url, created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .in('content_type', ['image', 'document'])
    .gte('created_at', new Date(Date.now() - MEDIA_LOOKBACK_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(3)
  if (mediaErr) {
    console.error('[inbound-buffer] media lookup failed:', mediaErr)
    return { superseded: false, receiptMediaIds: [] }
  }

  const rows = (media ?? []) as { media_url: string | null; created_at: string }[]
  const freshest = rows[0]
  const hasFreshMedia =
    freshest &&
    Date.now() - new Date(freshest.created_at).getTime() < FRESH_MEDIA_WINDOW_MS
  if (!hasFreshMedia) return { superseded: false, receiptMediaIds: [] }

  // Elapsed time alone cannot tell "page 2 just landed" from "the
  // customer asked something else a minute after we already read their
  // receipt" — inside the window both look like fresh media. Only the
  // second one re-runs a vision call over an image that has already been
  // priced, and two reads of one bill are not obliged to agree: that is
  // how a customer ends up holding two different quotes for one roof.
  //
  // An outbound message *after* the media is the durable signal that
  // this receipt already had its turn. It also covers the case that
  // matters most — a human took the thread over — where re-reading and
  // auto-sending a document is exactly what must not happen.
  const { data: answered, error: answeredErr } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .gt('created_at', freshest.created_at)
    .limit(1)
    .maybeSingle()
  if (answeredErr) {
    // Fail open, like the lookups above: a transient error here should
    // cost a redundant read, never a receipt that is silently ignored.
    console.error('[inbound-buffer] reply lookup failed:', answeredErr)
  } else if (answered) {
    return { superseded: false, receiptMediaIds: [] }
  }

  // media_url is `/api/whatsapp/media/<mediaId>` — recover the ids,
  // oldest first so page 1 precedes page 2 in the vision call.
  const receiptMediaIds = rows
    .map((r) => r.media_url?.split('/').pop())
    .filter((id): id is string => Boolean(id))
    .reverse()
  return { superseded: false, receiptMediaIds }
}
