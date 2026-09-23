import type { SupabaseClient } from '@supabase/supabase-js'
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api'

/**
 * Our own copies of the media customers send over WhatsApp.
 *
 * Meta keeps an inbound media id downloadable for 7 days and no longer.
 * The inbox used to fetch every photo and PDF from Meta on view, so a
 * customer's receipt stopped opening a week after they sent it. The
 * webhook now copies each file here as it arrives, and the media proxy
 * serves the copy before it ever asks Meta.
 *
 * The object path is derived from the media id alone — the same id
 * `messages.media_url` (`/api/whatsapp/media/<id>`) and
 * `ai_receipt_readings.media_ids` already carry — so neither needed
 * rewriting, and both now resolve to a file that outlives Meta's window.
 *
 * Private bucket (migration 049): written only through the service role,
 * read by account members through the RLS policy on the account folder.
 */
export const INBOUND_MEDIA_BUCKET = 'inbound-media'

/**
 * Meta's ids are numeric; this is looser than that on purpose, but it
 * never admits `/` or `.` — the id arrives in the proxy's URL and ends up
 * in a storage path.
 */
export function isValidMediaId(mediaId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(mediaId)
}

/** `account-<account_id>/<media_id>`. The leading segment is what the
 *  bucket's read policy matches on. */
export function inboundMediaPath(accountId: string, mediaId: string): string {
  if (!isValidMediaId(mediaId)) {
    throw new Error(`Invalid WhatsApp media id: ${JSON.stringify(mediaId)}`)
  }
  return `account-${accountId}/${mediaId}`
}

export interface StoreInboundMediaArgs {
  /** Service-role client — the bucket has no write policy. */
  db: SupabaseClient
  accountId: string
  mediaId: string
  bytes: Uint8Array
  contentType: string
}

/** Write one file. Throws on failure. */
export async function storeInboundMedia(
  args: StoreInboundMediaArgs,
): Promise<void> {
  const { db, accountId, mediaId, bytes, contentType } = args
  const { error } = await db.storage
    .from(INBOUND_MEDIA_BUCKET)
    .upload(inboundMediaPath(accountId, mediaId), bytes, {
      contentType,
      // The webhook, the proxy and the backfill script can all reach the
      // same id; whichever lands second rewrites identical bytes instead
      // of failing on "already exists".
      upsert: true,
      // A media id never points at different bytes.
      cacheControl: '31536000',
    })
  if (error) {
    throw new Error(`upload to ${INBOUND_MEDIA_BUCKET} failed: ${error.message}`)
  }
}

/**
 * Fetch a file from Meta. Throws on failure, with Meta's own message
 * when Meta is what failed — an id past its 7 days reads "does not
 * exist", which is how the backfill tells it apart from a storage error.
 */
export async function fetchInboundMediaFromMeta(args: {
  mediaId: string
  /** Decrypted token of the WhatsApp number the media arrived on. */
  accessToken: string
}): Promise<{ bytes: Buffer; contentType: string }> {
  const { mediaId, accessToken } = args
  const info = await getMediaUrl({ mediaId, accessToken })
  const { buffer, contentType } = await downloadMedia({
    downloadUrl: info.url,
    accessToken,
  })
  // `downloadMedia` sniffs the types it recognises (PDF, images) and
  // otherwise passes on the CDN's label, which for a voice note or a
  // .docx is often a bare octet-stream. Meta's own record of the type is
  // the better guess there, and this copy is the one we keep.
  return {
    bytes: buffer,
    contentType:
      contentType === 'application/octet-stream' ? info.mimeType : contentType,
  }
}

export interface CopyInboundMediaArgs {
  /** Service-role client — the bucket has no write policy. */
  db: SupabaseClient
  accountId: string
  mediaId: string
  /** Decrypted token of the WhatsApp number the media arrived on. */
  accessToken: string
}

/** Fetch a file from Meta and keep it. Throws on failure. */
export async function copyInboundMediaFromMeta(
  args: CopyInboundMediaArgs,
): Promise<{ contentType: string; size: number }> {
  const { db, accountId, mediaId, accessToken } = args
  const { bytes, contentType } = await fetchInboundMediaFromMeta({
    mediaId,
    accessToken,
  })
  await storeInboundMedia({ db, accountId, mediaId, bytes, contentType })
  return { contentType, size: bytes.length }
}

/**
 * The webhook's entry point: copy the file and never throw.
 *
 * A copy that fails here is not lost yet — the proxy keeps whatever it
 * serves from Meta, and `scripts/backfill-inbound-media.ts` sweeps the
 * rest — but it is on Meta's 7-day clock, so it is logged loudly.
 */
export async function archiveInboundMedia(
  args: CopyInboundMediaArgs,
): Promise<boolean> {
  try {
    await copyInboundMediaFromMeta(args)
    return true
  } catch (err) {
    console.error(
      `[inbound-media] could not archive media ${args.mediaId}; Meta deletes it 7 days after it arrived:`,
      err instanceof Error ? err.message : err,
    )
    return false
  }
}

/**
 * Our copy of a file, or null when there is none.
 *
 * Pass the caller's own session client, not the service role: the read
 * policy is what keeps one account out of another's folder.
 */
export async function readInboundMedia(args: {
  db: SupabaseClient
  accountId: string
  mediaId: string
}): Promise<Blob | null> {
  const { db, accountId, mediaId } = args
  const { data, error } = await db.storage
    .from(INBOUND_MEDIA_BUCKET)
    .download(inboundMediaPath(accountId, mediaId))
  if (error || !data) return null
  return data
}
