// ============================================================
// Review what the lifecycle sweep would do before switching it on.
//
//   npx tsx scripts/lifecycle-backlog.ts                  # dry run: list + CSV, changes nothing
//   npx tsx scripts/lifecycle-backlog.ts --exempt=keep.txt
//   npx tsx scripts/lifecycle-backlog.ts --apply          # one real run (caps + business hours apply)
//
// The dry run applies the same rules as the cron sweep
// (src/lib/lifecycle/rules.ts) to every open chat, with no per-run caps
// and ignoring business hours, and writes the result as a CSV outside
// the repo — it carries customer names. Someone reads it and picks the
// chats that must stay open.
//
// --exempt takes a file with those picks: any conversation or contact
// id found on a line counts (paste rows straight from the CSV). Each
// gets the "No cerrar" tag, which the sweep never touches. Remove the
// tag in the contact's sidebar to let the sweep have it again.
//
// --apply runs the sweep once for real, same as a cron run with
// LIFECYCLE_SWEEP=apply. Normally unnecessary: set the env var instead.
//
// Run from the repo root. Reads `.env` by hand, like the other scripts,
// and needs SUPABASE_SERVICE_ROLE_KEY; --apply also needs ENCRYPTION_KEY
// to send reminders.
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const EXEMPT_FILE = args.find((a) => a.startsWith('--exempt='))?.slice('--exempt='.length)
const OUT = args.find((a) => a.startsWith('--out='))?.slice('--out='.length)

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

function loadEnv(): void {
  for (const file of ['.env', '.env.local']) {
    let text: string
    try {
      text = readFileSync(join(ROOT, file), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  }
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

async function exempt(file: string): Promise<void> {
  // Imported after loadEnv: these modules read env at load time.
  const { supabaseAdmin } = await import('../src/lib/automations/admin-client')
  const { LIFECYCLE_CONFIG } = await import('../src/lib/lifecycle/config')
  const db = supabaseAdmin()

  const ids = [...new Set(readFileSync(file, 'utf8').match(UUID_RE) ?? [])].map((s) => s.toLowerCase())
  if (ids.length === 0) throw new Error(`No conversation or contact ids found in ${file}`)

  // Resolve each id to a contact, whether it names a conversation or a contact.
  const [{ data: convs, error: convErr }, { data: contacts, error: contactErr }] = await Promise.all([
    db.from('conversations').select('contact_id, account_id').in('id', ids),
    db.from('contacts').select('id, account_id').in('id', ids),
  ])
  if (convErr || contactErr) throw new Error((convErr ?? contactErr)!.message)
  const byAccount = new Map<string, Set<string>>()
  for (const row of [
    ...(convs ?? []).map((c) => ({ contact: c.contact_id as string, account: c.account_id as string })),
    ...(contacts ?? []).map((c) => ({ contact: c.id as string, account: c.account_id as string })),
  ]) {
    const set = byAccount.get(row.account) ?? new Set<string>()
    set.add(row.contact)
    byAccount.set(row.account, set)
  }

  const { data: configs } = await db.from('whatsapp_config').select('account_id, user_id')
  const ownerByAccount = new Map((configs ?? []).map((c) => [c.account_id as string, c.user_id as string]))

  let linked = 0
  for (const [accountId, contactIds] of byAccount) {
    const name = LIFECYCLE_CONFIG.exemptTagName
    const { data: existing } = await db
      .from('tags')
      .select('id')
      .eq('account_id', accountId)
      .ilike('name', name)
      .limit(1)
      .maybeSingle()
    let tagId = existing?.id as string | undefined
    if (!tagId) {
      const owner = ownerByAccount.get(accountId)
      if (!owner) throw new Error(`No WhatsApp config (tag owner) for account ${accountId}`)
      const { data: created, error } = await db
        .from('tags')
        .insert({ account_id: accountId, user_id: owner, name, color: '#64748b' })
        .select('id')
        .single()
      if (error) throw new Error(`creating the "${name}" tag: ${error.message}`)
      tagId = created.id as string
    }
    const { error } = await db.from('contact_tags').upsert(
      [...contactIds].map((contact_id) => ({ contact_id, tag_id: tagId })),
      { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
    )
    if (error) throw new Error(`tagging contacts: ${error.message}`)
    linked += contactIds.size
  }

  const unmatched = ids.length - (convs?.length ?? 0) - (contacts?.length ?? 0)
  console.log(`Tagged ${linked} contact(s) "${LIFECYCLE_CONFIG.exemptTagName}".`)
  if (unmatched > 0) console.log(`${unmatched} id(s) in the file matched nothing.`)
}

async function report(): Promise<void> {
  const { supabaseAdmin } = await import('../src/lib/automations/admin-client')
  const { runLifecycleSweep } = await import('../src/lib/lifecycle/sweep')
  const db = supabaseAdmin()

  let runId: string | null = null
  if (APPLY) {
    const { data, error } = await db
      .from('lifecycle_runs')
      .insert({ mode: 'apply', source: 'script' })
      .select('id')
      .single()
    if (error) throw new Error(`starting the run: ${error.message}`)
    runId = data.id as string
  }

  const { rows, summary } = await runLifecycleSweep(
    APPLY
      ? { mode: 'apply', runId, db }
      : { mode: 'dry_run', caps: null, ignoreBusinessHours: true, db },
  )

  if (runId) {
    await db
      .from('lifecycle_runs')
      .update({ finished_at: new Date().toISOString(), summary })
      .eq('id', runId)
  }

  const header = [
    'action',
    'reason',
    'contact',
    'phone_last4',
    'stage',
    'silent_days',
    'assigned',
    'outcome',
    'conversation_id',
    'contact_id',
  ]
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.action,
        r.reason,
        r.contactName,
        r.phoneLast4,
        r.stage,
        r.silentDays,
        r.assigned ? 'yes' : 'no',
        r.outcome,
        r.conversationId,
        r.contactId,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  const stamp = new Date().toISOString().slice(0, 10)
  const out = OUT ?? join(tmpdir(), `lifecycle-backlog-${stamp}${APPLY ? '-applied' : ''}.csv`)
  writeFileSync(out, lines.join('\n') + '\n')

  const byKey = new Map<string, number>()
  for (const r of rows) {
    const key = `${r.action.padEnd(8)} ${r.reason}`
    byKey.set(key, (byKey.get(key) ?? 0) + 1)
  }
  console.log(APPLY ? 'Applied one sweep run.' : 'Dry run — nothing was changed.')
  console.log(`Open chats considered: ${summary.considered}`)
  for (const [key, count] of [...byKey].sort()) console.log(`  ${String(count).padStart(4)}  ${key}`)
  if (APPLY) console.log(`Failed: ${summary.failed}  Skipped: ${summary.skipped}`)
  console.log(`CSV: ${out}`)
}

async function main(): Promise<void> {
  loadEnv()
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env)')
  }
  if (EXEMPT_FILE) await exempt(EXEMPT_FILE)
  else await report()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
