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

/**
 * How long a delivery waits before deciding it owns the burst's reply.
 *
 * Eight seconds covered a customer typing two messages in a row, and
 * nothing else. Attaching a file does not fit in it: "Ok" followed by
 * the CFE bill is one thought, but finding the PDF takes ten to twenty
 * seconds, so the bot answered the "Ok" alone and the bill arrived to a
 * conversation that had already moved on. Twenty seconds covers the
 * attachment without making a plain text question feel abandoned.
 *
 * The ceiling is the webhook route's `maxDuration`: this sleep runs
 * inside it, ahead of a vision call, a chat call and a PDF render.
 */
const DEFAULT_DEBOUNCE_MS = 20_000

/** How far back a burst can reach for receipt media. Covers "page 1,
 *  then page 2 three minutes later while they find it". */
const MEDIA_LOOKBACK_MS = 15 * 60_000

/** Only bursts that actually contain FRESH media trigger a (re-)read —
 *  a "gracias" text minutes after the receipt must not re-extract. */
const FRESH_MEDIA_WINDOW_MS = 90_000

/**
 * How many media one burst carries forward. Three covered a single
 * two-page bill with room to spare; a property split across meters
 * sends one bill per meter, so the ceiling now matches what the reader
 * will look at in a turn (MAX_MEDIA_PER_TURN in `receipt.ts`).
 *
 * Handing over more than were read is not waste: bills already
 * extracted on an earlier turn are skipped by id, so the extra ids cost
 * a set lookup rather than a vision call.
 */
const MAX_BURST_MEDIA = 6

/** What the webhook stores in `messages.media_url` for inbound media —
 *  the id is the last segment. Kept here because this module is the one
 *  that converts between the two, in both directions. */
const INBOUND_MEDIA_PREFIX = '/api/whatsapp/media/'

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
 * Record that a turn has looked at this media, so no later burst hands
 * it over again.
 *
 * Called once per turn that reached the reader, whether or not the read
 * produced anything: a bill the vision model could not parse has still
 * had its call, and paying for it twice does not make it legible. The
 * bot's own "please resend it" is what moves that conversation on, and
 * the resend arrives as a new media id.
 *
 * NEVER throws — a bookkeeping failure must not cost the customer the
 * reply this turn is on its way to send.
 */
export async function markReceiptMediaRead(
  db: SupabaseClient,
  args: { conversationId: string; mediaIds: readonly string[] },
): Promise<void> {
  if (args.mediaIds.length === 0) return
  try {
    const { error } = await db
      .from('messages')
      .update({ ai_receipt_read_at: new Date().toISOString() })
      .eq('conversation_id', args.conversationId)
      .in(
        'media_url',
        args.mediaIds.map((id) => `${INBOUND_MEDIA_PREFIX}${id}`),
      )
    if (error) throw error
  } catch (err) {
    console.error('[inbound-buffer] failed to mark media as read:', err)
  }
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

  // Only media no turn has read yet. `ai_receipt_read_at` is written by
  // the turn that actually spent the vision call, which is the only
  // thing that can tell "we already priced this bill" from "a reply
  // about something else happened to land after it" — the distinction
  // that used to cost a customer their quote (see migration 048).
  const { data: media, error: mediaErr } = await db
    .from('messages')
    .select('media_url, created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .in('content_type', ['image', 'document'])
    .is('ai_receipt_read_at', null)
    .gte('created_at', new Date(Date.now() - MEDIA_LOOKBACK_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(MAX_BURST_MEDIA)
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

  // A HUMAN message after the media is the one signal that still stops
  // the read: an agent has the thread, and re-reading a bill to
  // auto-send a document underneath what they are typing is exactly
  // what must not happen. The bot's own messages deliberately do not
  // count — that check could not tell which message the bot was
  // answering, so a reply that raced ahead of the attachment locked the
  // receipt out of every turn that followed. Being unread is now what
  // makes media eligible, and the query above already enforces it.
  const { data: answered, error: answeredErr } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'agent')
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
