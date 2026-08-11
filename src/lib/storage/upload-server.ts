import type { SupabaseClient } from '@supabase/supabase-js'
import { buildMediaPath } from './upload-media'

/**
 * Server-side counterpart to `uploadAccountMedia`.
 *
 * That one runs in the browser: it calls `supabase.auth.getUser()` and
 * resolves the account from the signed-in profile. The bot has neither —
 * it reacts to a webhook with no `auth.uid()` and holds the account id
 * already — so it needs its own entry point, taking bytes instead of a
 * `File` and a caller-supplied client.
 *
 * The path convention is shared deliberately (`buildMediaPath`): the
 * bucket's RLS write policies match on the leading `account-<uuid>`
 * segment. The service role bypasses RLS, so a wrong path here would
 * still upload — and then be invisible to every policy-gated reader.
 */
export interface UploadServerMediaArgs {
  /** Service-role client — this path has no user session. */
  db: SupabaseClient
  bucket: string
  accountId: string
  bytes: Uint8Array
  /** Original name; only its basename and extension survive. */
  fileName: string
  contentType: string
}

export interface UploadServerMediaResult {
  /** Public URL. Meta fetches this itself at send time, so it must be
   *  reachable without auth — hence a public bucket, not a signed URL
   *  that would expire mid-send. */
  publicUrl: string
  path: string
}

export async function uploadServerMedia(
  args: UploadServerMediaArgs,
): Promise<UploadServerMediaResult> {
  const { db, bucket, accountId, bytes, fileName, contentType } = args

  const path = buildMediaPath(accountId, fileName)
  const { error } = await db.storage.from(bucket).upload(path, bytes, {
    cacheControl: '3600',
    upsert: false,
    contentType,
  })
  if (error) throw new Error(`upload to ${bucket} failed: ${error.message}`)

  const {
    data: { publicUrl },
  } = db.storage.from(bucket).getPublicUrl(path)

  return { publicUrl, path }
}
