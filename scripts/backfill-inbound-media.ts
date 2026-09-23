// ============================================================
// Copy the media customers sent before the webhook kept its own copy.
//
//   npx tsx scripts/backfill-inbound-media.ts            # dry run: asks Meta what is still there
//   npx tsx scripts/backfill-inbound-media.ts --apply    # downloads it into inbound-media
//
// Meta keeps an inbound media id downloadable for 7 days. Until migration
// 049 the CRM stored only that id, so every receipt older than a week was
// already gone when this was written; this rescues whatever is still
// inside the window and lists the rest, so someone can ask those
// customers to send the file again.
//
// Idempotent: media already in the bucket is skipped without calling
// Meta. Safe to re-run — and worth re-running once right after the
// webhook change deploys, to catch what arrived in between. Doubles as a
// health check afterwards: a dry run that finds nothing missing means
// the webhook is keeping up.
//
// Run from the repo root. Reads `.env` by hand, like
// setup-automations.mjs, and needs SUPABASE_SERVICE_ROLE_KEY (the bucket
// has no write policy) plus ENCRYPTION_KEY (to decrypt the WhatsApp
// token Meta wants).
// ============================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const ROOT = process.cwd()
const APPLY = process.argv.includes('--apply')
const MEDIA_PREFIX = '/api/whatsapp/media/'

function loadEnv(): void {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
}

interface MediaMessage {
  id: string
  created_at: string
  content_type: string
  content_text: string | null
  media_url: string
  conversation: {
    account_id: string
    contact: { name: string | null; phone: string | null } | null
  } | null
}

type Outcome = 'archived' | 'recoverable' | 'copied' | 'expired' | 'failed'

async function main(): Promise<void> {
  loadEnv()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !process.env.ENCRYPTION_KEY) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or ENCRYPTION_KEY in .env',
    )
  }

  // encryption.ts reads ENCRYPTION_KEY when it loads, so these imports
  // have to wait for the env above.
  const { decrypt } = await import('../src/lib/whatsapp/encryption')
  const { getMediaUrl } = await import('../src/lib/whatsapp/meta-api')
  const { INBOUND_MEDIA_BUCKET, copyInboundMediaFromMeta, isValidMediaId } =
    await import('../src/lib/storage/inbound-media')

  const db = createClient(url, key, { auth: { persistSession: false } })

  // Tokens per account — the media id is only readable with the token of
  // the number it arrived on.
  const { data: configs, error: configError } = await db
    .from('whatsapp_config')
    .select('account_id, access_token')
  if (configError) throw configError
  const tokens = new Map<string, string>()
  for (const c of configs ?? []) {
    tokens.set(c.account_id as string, decrypt(c.access_token as string))
  }

  const messages: MediaMessage[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('messages')
      .select(
        'id, created_at, content_type, content_text, media_url, conversation:conversations(account_id, contact:contacts(name, phone))',
      )
      .eq('sender_type', 'customer')
      .like('media_url', `${MEDIA_PREFIX}%`)
      .order('created_at', { ascending: false })
      .range(from, from + 999)
    if (error) throw error
    messages.push(...((data ?? []) as unknown as MediaMessage[]))
    if (!data || data.length < 1000) break
  }

  // What each account already has, one listing per account rather than a
  // request per file.
  const stored = new Map<string, Set<string>>()
  async function storedFor(accountId: string): Promise<Set<string>> {
    const cached = stored.get(accountId)
    if (cached) return cached
    const names = new Set<string>()
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.storage
        .from(INBOUND_MEDIA_BUCKET)
        .list(`account-${accountId}`, { limit: 1000, offset })
      if (error) throw error
      for (const o of data ?? []) names.add(o.name)
      if (!data || data.length < 1000) break
    }
    stored.set(accountId, names)
    return names
  }

  const counts: Record<Outcome, number> = {
    archived: 0,
    recoverable: 0,
    copied: 0,
    expired: 0,
    failed: 0,
  }
  const lost: string[] = []

  for (const m of messages) {
    const mediaId = m.media_url.slice(MEDIA_PREFIX.length)
    const accountId = m.conversation?.account_id
    const who =
      m.conversation?.contact?.name || m.conversation?.contact?.phone || '(sin contacto)'
    const label = `${m.created_at.slice(0, 10)}  ${m.content_type.padEnd(8)}  ${who}${
      m.content_text ? ` — ${m.content_text.slice(0, 60)}` : ''
    }`

    if (!accountId || !isValidMediaId(mediaId)) {
      counts.failed++
      console.log(`✗ ${label}  (sin cuenta o id inválido: ${mediaId})`)
      continue
    }
    if ((await storedFor(accountId)).has(mediaId)) {
      counts.archived++
      continue
    }
    const accessToken = tokens.get(accountId)
    if (!accessToken) {
      counts.failed++
      console.log(`✗ ${label}  (la cuenta no tiene WhatsApp configurado)`)
      continue
    }

    let outcome: Outcome
    let detail = ''
    try {
      if (APPLY) {
        const { contentType, size } = await copyInboundMediaFromMeta({
          db,
          accountId,
          mediaId,
          accessToken,
        })
        outcome = 'copied'
        detail = `${contentType}, ${Math.round(size / 1024)} KB`
      } else {
        await getMediaUrl({ mediaId, accessToken })
        outcome = 'recoverable'
      }
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err)
      // Meta answers an id past its window with "(#100) ... Object with
      // ID '...' does not exist".
      outcome = /does not exist|not found/i.test(detail) ? 'expired' : 'failed'
    }
    counts[outcome]++

    if (outcome === 'expired') lost.push(label)
    else if (outcome === 'failed') console.log(`✗ ${label}  (${detail})`)
    else console.log(`${outcome === 'copied' ? '✓' : '•'} ${label}${detail ? `  (${detail})` : ''}`)
  }

  if (lost.length > 0) {
    console.log(`\nYa no están en Meta (${lost.length}) — hay que pedírselos al cliente de nuevo:`)
    for (const l of lost) console.log(`  ${l}`)
  }

  console.log(
    `\n${messages.length} archivos de clientes: ${counts.archived} ya guardados, ` +
      (APPLY
        ? `${counts.copied} copiados ahora`
        : `${counts.recoverable} recuperables (corre con --apply para copiarlos)`) +
      `, ${counts.expired} expirados en Meta, ${counts.failed} con error.`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
