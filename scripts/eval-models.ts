// ============================================================
// Compare candidate models before the bot switches to one of them.
//
//   npx tsx scripts/eval-models.ts vision --arm gpt-5.6-luna:default --arm gpt-6-luna:low [--limit 30] [--repeat 2]
//   npx tsx scripts/eval-models.ts chat --arm gpt-5.6-terra:none --arm gpt-6.1-sol:low [--limit 60] [--repeat 1]
//   npx tsx scripts/eval-models.ts shadow-report [--days 14]
//
// An arm is `model:effort` — `default` (or no suffix) sends the code
// default, exactly as an account with no effort chosen would.
//
// vision  Re-reads the bills behind `ai_receipt_readings` from our own
//         copies in `inbound-media` (reads from before migration 049 have
//         no copy and are skipped) and compares every arm, field by
//         field, with the extraction production built its quote on.
//         The prompt and the files are exactly what production saw.
//
// chat    Replays recent auto-reply turns: the conversation as it stood
//         just before the reply, the knowledge base, the date note for
//         that moment. What a replay cannot rebuild is the per-turn
//         system notes (receipt reading, pricing, meters), so every arm
//         is compared with the FIRST arm run here on the same inputs —
//         make that today's model — not with the reply that was sent.
//         The quote turns are what `shadow-report` is for.
//
// shadow-report  Summarises `ai_shadow_runs` (AI_SHADOW_ARMS): candidate
//         answers to live turns, next to the reply the customer got.
//
// Read-only against production: nothing is sent and nothing is written
// to the database. It does spend tokens on the account's own key, and a
// full run of both replays costs a few dollars. Reports land in
// `eval-out/`, which is gitignored — they carry customer conversations
// and bills.
//
// Run from the repo root. Reads `.env` by hand, like the other scripts,
// and needs SUPABASE_SERVICE_ROLE_KEY plus ENCRYPTION_KEY (to decrypt
// the provider key stored in ai_configs).
// ============================================================
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '../src/lib/ai/config'
import { buildConversationContext } from '../src/lib/ai/context'
import {
  aiContextMessageLimit,
  buildDateTimeNote,
  buildSystemPrompt,
} from '../src/lib/ai/defaults'
import { generateReply } from '../src/lib/ai/generate'
import { retrieveKnowledge } from '../src/lib/ai/knowledge'
import { latestUserMessage } from '../src/lib/ai/query'
import {
  extractReceiptFromFiles,
  type MediaFile,
  type ReceiptExtraction,
} from '../src/lib/ai/receipt'
import { parseShadowArms, shadowMarkers, type ShadowArm } from '../src/lib/ai/shadow'
import type { AiConfig, GenerateResult } from '../src/lib/ai/types'
import { INBOUND_MEDIA_BUCKET, inboundMediaPath } from '../src/lib/storage/inbound-media'

const ROOT = process.cwd()
const OUT_DIR = join(ROOT, 'eval-out')

function loadEnv(): void {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
}

// ------------------------------------------------------------
// Arguments
// ------------------------------------------------------------

const argv = process.argv.slice(2)
const MODE = argv[0]

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

function flags(name: string): string[] {
  const out: string[] = []
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1])
  })
  return out
}

function numberFlag(name: string, fallback: number): number {
  const n = Number(flag(name))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const armLabel = (arm: ShadowArm) => `${arm.model}:${arm.reasoningEffort ?? 'default'}`

// ------------------------------------------------------------
// Prices, USD per 1M tokens (developers.openai.com, 2026-10-01).
// Reasoning tokens are billed as output and already sit inside the
// completion count.
// ------------------------------------------------------------

const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6-sol': { input: 2, cached: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
}

function costUsd(
  model: string,
  u: { prompt: number; cached: number; completion: number },
): number | null {
  const p = PRICES[model]
  if (!p) return null
  return (
    ((u.prompt - u.cached) * p.input + u.cached * p.cached + u.completion * p.output) /
    1_000_000
  )
}

// ------------------------------------------------------------
// Call capture. Wraps fetch so every chat-completions call reports its
// usage, finish reason, status and latency to whichever task made it —
// without touching the code paths under test.
// ------------------------------------------------------------

interface CallRecord {
  status: number
  ms: number
  finishReason: string | null
  prompt: number
  cached: number
  completion: number
  reasoning: number
  errorBody: string | null
}

const calls = new AsyncLocalStorage<CallRecord[]>()
const realFetch = globalThis.fetch

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const sink = calls.getStore()
  if (!sink || !url.includes('/v1/chat/completions')) return realFetch(input, init)
  const started = Date.now()
  const res = await realFetch(input, init)
  const ms = Date.now() - started
  const record: CallRecord = {
    status: res.status,
    ms,
    finishReason: null,
    prompt: 0,
    cached: 0,
    completion: 0,
    reasoning: 0,
    errorBody: null,
  }
  try {
    if (res.ok) {
      const data = await res.clone().json()
      record.finishReason = data?.choices?.[0]?.finish_reason ?? null
      record.prompt = data?.usage?.prompt_tokens ?? 0
      record.cached = data?.usage?.prompt_tokens_details?.cached_tokens ?? 0
      record.completion = data?.usage?.completion_tokens ?? 0
      record.reasoning = data?.usage?.completion_tokens_details?.reasoning_tokens ?? 0
    } else {
      record.errorBody = (await res.clone().text()).slice(0, 300)
    }
  } catch {
    // A body we can't read is still a call that happened.
  }
  sink.push(record)
  return res
}

async function captured<T>(fn: () => Promise<T>): Promise<{ value: T | null; error: string | null; calls: CallRecord[] }> {
  const sink: CallRecord[] = []
  try {
    const value = await calls.run(sink, fn)
    return { value, error: null, calls: sink }
  } catch (err) {
    const code = (err as { code?: unknown })?.code
    const message = err instanceof Error ? err.message : String(err)
    return { value: null, error: typeof code === 'string' ? `${code}: ${message}` : message, calls: sink }
  }
}

async function pool<T>(items: T[], size: number, run: (item: T, i: number) => Promise<void>) {
  let next = 0
  let done = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        await run(items[i], i)
        done++
        if (done % 10 === 0 || done === items.length) {
          process.stderr.write(`  ${done}/${items.length}\n`)
        }
      }
    }),
  )
}

// ------------------------------------------------------------
// Small statistics + formatting.
// ------------------------------------------------------------

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

const avg = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—')
const fmt = (v: number | null, digits = 0) => (v == null ? '—' : v.toFixed(digits))
const usd = (v: number | null) => (v == null ? '—' : `$${v.toFixed(3)}`)
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ⏎ ')

function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n')
}

function writeReport(name: string, markdown: string, raw: unknown) {
  mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
  const md = join(OUT_DIR, `${name}-${stamp}.md`)
  writeFileSync(md, markdown)
  writeFileSync(join(OUT_DIR, `${name}-${stamp}.json`), JSON.stringify(raw, null, 2))
  console.log(`\nReport: ${md}`)
}

/**
 * Text that suggests the model talked about its instructions instead
 * of to the customer — the failure that once made the bot reply "no
 * hagas nada, solo es pregunta". A heuristic for review, not a verdict.
 */
const LEAK_RE =
  /NOTA DEL SISTEMA|\[\[|\[[A-ZÁÉÍÓÚ_]{4,}\s*:|system prompt|\binstrucciones\b|\bel cliente (dice|pregunta|quiere|escribi)|\bdebo (responder|contestar)|no hagas nada|\b(I should|The user|the customer|Let me)\b/i

function leaks(text: string | null | undefined): boolean {
  return !!text && LEAK_RE.test(text)
}

// ------------------------------------------------------------
// Setup shared by the modes.
// ------------------------------------------------------------

async function setup(): Promise<{ db: SupabaseClient; accountId: string; config: AiConfig }> {
  loadEnv()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env')
  const db = createClient(url, key, { auth: { persistSession: false } })

  let accountId = flag('account')
  if (!accountId) {
    const { data, error } = await db.from('ai_configs').select('account_id')
    if (error) throw error
    if (!data || data.length !== 1) {
      throw new Error(`Found ${data?.length ?? 0} AI configs — pass --account <id>.`)
    }
    accountId = data[0].account_id as string
  }

  const config = await loadAiConfig(db, accountId, { requireActive: false })
  if (!config) throw new Error(`No AI config for account ${accountId}.`)
  if (config.provider !== 'openai') throw new Error('This script compares OpenAI models only.')
  return { db, accountId, config }
}

function readArms(): ShadowArm[] {
  const arms = parseShadowArms(flags('arm').join(','))
  if (arms.length === 0) {
    throw new Error('Pass at least one --arm model:effort (the first is the baseline).')
  }
  return arms
}

// ------------------------------------------------------------
// vision
// ------------------------------------------------------------

/** The fields a quote is built on come first. */
const VISION_FIELDS = [
  'promedio_bimestral_kwh',
  'tarifa',
  'consumo_periodo_actual_kwh',
  'historial_bimestres_kwh',
  'cantidad_periodos_usados',
  'importe_periodo_mxn',
  'importe_total_a_pagar_mxn',
  'periodo_actual',
  'numero_servicio',
  'ciudad',
] as const satisfies readonly (keyof ReceiptExtraction)[]

const CRITICAL_FIELDS = new Set(['promedio_bimestral_kwh', 'tarifa', 'historial_bimestres_kwh'])

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

async function runVision() {
  const { db, accountId, config } = await setup()
  const arms = readArms()
  const limit = numberFlag('limit', 30)
  const repeat = numberFlag('repeat', 1)
  const concurrency = numberFlag('concurrency', 4)

  const { data: readings, error } = await db
    .from('ai_receipt_readings')
    .select('id, created_at, source, model, parsed, media_ids')
    .eq('account_id', accountId)
    .not('parsed', 'is', null)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error

  // Only reads whose every file still exists in our bucket.
  const samples: { id: string; createdAt: string; prodModel: string; parsed: ReceiptExtraction; files: MediaFile[]; kinds: string }[] = []
  let skipped = 0
  for (const r of readings ?? []) {
    if (samples.length >= limit) break
    const mediaIds = (r.media_ids as string[]) ?? []
    if (mediaIds.length === 0) {
      skipped++
      continue
    }
    const files: MediaFile[] = []
    for (const mediaId of mediaIds) {
      const { data: blob } = await db.storage
        .from(INBOUND_MEDIA_BUCKET)
        .download(inboundMediaPath(accountId, mediaId))
      if (!blob) break
      files.push({
        base64: Buffer.from(await blob.arrayBuffer()).toString('base64'),
        mimeType: blob.type || 'application/octet-stream',
      })
    }
    if (files.length !== mediaIds.length) {
      skipped++
      continue
    }
    samples.push({
      id: r.id as string,
      createdAt: r.created_at as string,
      prodModel: r.model as string,
      parsed: r.parsed as ReceiptExtraction,
      files,
      kinds: files.map((f) => (f.mimeType === 'application/pdf' ? 'pdf' : 'img')).join('+'),
    })
  }
  console.log(`vision: ${samples.length} bills (${skipped} skipped: no stored copy) × ${arms.length} arms × ${repeat}`)

  type Run = {
    sample: number
    arm: string
    model: string
    rep: number
    extraction: ReceiptExtraction | null
    error: string | null
    calls: CallRecord[]
  }
  const jobs = samples.flatMap((_, s) =>
    arms.flatMap((arm) => Array.from({ length: repeat }, (_, rep) => ({ s, arm, rep }))),
  )
  const runs: Run[] = []
  await pool(jobs, concurrency, async ({ s, arm, rep }) => {
    const r = await captured(() =>
      extractReceiptFromFiles(
        {
          provider: 'openai',
          visionModel: arm.model,
          visionReasoningEffort: arm.reasoningEffort,
          apiKey: config.apiKey,
        },
        samples[s].files,
      ),
    )
    runs.push({ sample: s, arm: armLabel(arm), model: arm.model, rep, extraction: r.value, error: r.error, calls: r.calls })
  })

  const lines: string[] = [
    `# Vision replay — ${new Date().toISOString()}`,
    '',
    `${samples.length} bills (${samples.filter((s) => s.kinds.includes('pdf')).length} with a PDF), ${repeat} run(s) per arm. ` +
      'Compared with the extraction production stored for each bill. A disagreement is not automatically the candidate\'s fault: check it against the bill.',
    '',
  ]

  const summary: string[][] = []
  for (const arm of arms) {
    const label = armLabel(arm)
    const mine = runs.filter((r) => r.arm === label)
    const parsedOk = mine.filter((r) => r.extraction)
    const httpErrors = mine.filter((r) => r.calls.some((c) => c.status !== 200))
    const truncated = mine.filter((r) => r.calls.some((c) => c.finishReason === 'length'))
    const fieldMatch = (field: string) =>
      pct(
        parsedOk.filter((r) => sameValue(r.extraction![field as keyof ReceiptExtraction], samples[r.sample].parsed[field as keyof ReceiptExtraction])).length,
        parsedOk.length,
      )
    // Same arm, same bill, different run: how much it disagrees with itself.
    let pairs = 0
    let stable = 0
    for (let s = 0; s < samples.length; s++) {
      const reps = parsedOk.filter((r) => r.sample === s)
      for (let i = 1; i < reps.length; i++) {
        pairs++
        if (sameValue(reps[i].extraction!.promedio_bimestral_kwh, reps[0].extraction!.promedio_bimestral_kwh)) stable++
      }
    }
    const allCalls = mine.flatMap((r) => r.calls)
    const costs = allCalls.map((c) => costUsd(arm.model, c)).filter((c): c is number => c != null)
    summary.push([
      label,
      `${parsedOk.length}/${mine.length}`,
      String(httpErrors.length),
      String(truncated.length),
      ...['promedio_bimestral_kwh', 'tarifa', 'historial_bimestres_kwh'].map(fieldMatch),
      pairs ? pct(stable, pairs) : '—',
      fmt(avg(allCalls.map((c) => c.reasoning))),
      fmt(percentile(allCalls.map((c) => c.ms), 50) ?? null),
      fmt(percentile(allCalls.map((c) => c.ms), 95) ?? null),
      usd(costs.length ? (avg(costs)! * 100) : null),
    ])
  }
  lines.push(
    '## Summary',
    '',
    table(
      ['arm', 'parsed', 'http errors', 'truncated', 'promedio = prod', 'tarifa = prod', 'historial = prod', 'promedio stable across runs', 'avg reasoning tok', 'p50 ms', 'p95 ms', 'cost / 100 bills'],
      summary,
    ),
    '',
  )

  const firstErrors = runs.filter((r) => r.calls.some((c) => c.errorBody)).slice(0, 5)
  if (firstErrors.length) {
    lines.push('## Provider errors (first 5)', '')
    for (const r of firstErrors) {
      lines.push(`- ${r.arm} on bill ${samples[r.sample].id} (${samples[r.sample].kinds}): \`${r.calls.find((c) => c.errorBody)!.errorBody}\``)
    }
    lines.push('')
  }

  lines.push('## Disagreements with production', '')
  for (let s = 0; s < samples.length; s++) {
    const sample = samples[s]
    const diffs: string[] = []
    for (const r of runs.filter((r) => r.sample === s)) {
      if (!r.extraction) {
        diffs.push(`- **${r.arm}** #${r.rep + 1}: no extraction${r.error ? ` (${r.error})` : ''}`)
        continue
      }
      for (const field of VISION_FIELDS) {
        const prod = sample.parsed[field]
        const got = r.extraction[field]
        if (!sameValue(prod, got)) {
          diffs.push(
            `- **${r.arm}** #${r.rep + 1} ${CRITICAL_FIELDS.has(field) ? '⚠︎ ' : ''}\`${field}\`: prod \`${JSON.stringify(prod)}\` → \`${JSON.stringify(got)}\``,
          )
        }
      }
    }
    if (diffs.length) {
      lines.push(`### Bill ${sample.id} — ${sample.createdAt.slice(0, 10)}, ${sample.kinds}, read in prod by ${sample.prodModel}`, '', ...diffs, '')
    }
  }

  writeReport('vision', lines.join('\n'), {
    // The bills themselves stay out of the dump; the ids lead back to them.
    samples: samples.map((s) => ({ id: s.id, createdAt: s.createdAt, prodModel: s.prodModel, kinds: s.kinds, parsed: s.parsed })),
    runs,
  })
}

// ------------------------------------------------------------
// chat
// ------------------------------------------------------------

type Markers = ReturnType<typeof shadowMarkers>
const MARKER_KEYS: (keyof Markers)[] = [
  'handoff',
  'leadStatus',
  'quoteSent',
  'metersExpected',
  'holdQuote',
  'consumptionVerdict',
  'packagePanels',
]

interface Turn {
  conversationId: string
  createdAt: string
  sentText: string
  context: { role: 'user' | 'assistant'; content: string }[]
  systemPrompt: string
}

async function collectTurns(db: SupabaseClient, accountId: string, config: AiConfig, limit: number, perConversation: number, days: number): Promise<Turn[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const { data: recent, error } = await db
    .from('messages')
    .select('conversation_id, created_at, conversations!inner(account_id)')
    .eq('conversations.account_id', accountId)
    .eq('ai_generated', true)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1000)
  if (error) throw error

  const conversationIds = [...new Set((recent ?? []).map((m) => m.conversation_id as string))]
  const turns: Turn[] = []
  for (const conversationId of conversationIds) {
    if (turns.length >= limit) break
    const { data: rows, error: rowsError } = await db
      .from('messages')
      .select('sender_type, content_type, content_text, created_at, ai_generated')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
    if (rowsError) throw rowsError
    const all = rows ?? []

    // A turn starts at an AI reply right after the customer; the reply
    // the customer got is that message plus any that followed it.
    const starts: number[] = []
    for (let i = 1; i < all.length; i++) {
      if (all[i].ai_generated && all[i].content_type === 'text' && all[i - 1].sender_type === 'customer' && all[i].created_at >= since) {
        starts.push(i)
      }
    }
    for (const i of starts.reverse().slice(0, perConversation)) {
      if (turns.length >= limit) break
      const sent: string[] = []
      for (let j = i; j < all.length && all[j].ai_generated && all[j].sender_type === 'bot'; j++) {
        if (all[j].content_text) sent.push(all[j].content_text as string)
      }
      const createdAt = all[i].created_at as string
      const context = await buildConversationContext(db, conversationId, aiContextMessageLimit(), { before: createdAt })
      if (context.length === 0) continue
      // Same order as the live bot: the knowledge query is the customer's
      // own words, read before any note joins the turn.
      const knowledge = await retrieveKnowledge(db, accountId, config, latestUserMessage(context))
      context.push({ role: 'user', content: buildDateTimeNote(new Date(createdAt)) })
      turns.push({
        conversationId,
        createdAt,
        sentText: sent.join('\n\n'),
        context,
        systemPrompt: buildSystemPrompt({ userPrompt: config.systemPrompt, mode: 'auto_reply', knowledge }),
      })
    }
  }
  return turns
}

interface ChatRun {
  turn: number
  arm: string
  model: string
  rep: number
  result: GenerateResult | null
  error: string | null
  calls: CallRecord[]
}

function chatSummary(arms: ShadowArm[], runs: ChatRun[], baselineLabel: string): string[][] {
  const rows: string[][] = []
  for (const arm of arms) {
    const label = armLabel(arm)
    const mine = runs.filter((r) => r.arm === label)
    const ok = mine.filter((r) => r.result)
    const agree = (key: keyof Markers) => {
      let n = 0
      let same = 0
      for (const r of ok) {
        const base = runs.find((b) => b.arm === baselineLabel && b.turn === r.turn && b.rep === 0 && b.result)
        if (!base) continue
        n++
        if (sameValue(base.result![key], r.result![key])) same++
      }
      return pct(same, n)
    }
    const allCalls = mine.flatMap((r) => r.calls)
    const costs = allCalls.map((c) => costUsd(arm.model, c)).filter((c): c is number => c != null)
    rows.push([
      label,
      `${ok.length}/${mine.length}`,
      String(mine.filter((r) => r.error?.startsWith('empty_response')).length),
      String(ok.filter((r) => leaks(r.result!.text)).length),
      agree('handoff'),
      ...MARKER_KEYS.filter((k) => k !== 'handoff').map(agree),
      fmt(avg(ok.map((r) => r.result!.text.length))),
      fmt(avg(allCalls.map((c) => c.reasoning))),
      pct(allCalls.reduce((a, c) => a + c.cached, 0), allCalls.reduce((a, c) => a + c.prompt, 0)),
      fmt(percentile(allCalls.map((c) => c.ms), 50) ?? null),
      fmt(percentile(allCalls.map((c) => c.ms), 95) ?? null),
      usd(costs.length ? avg(costs)! * 100 : null),
    ])
  }
  return rows
}

const CHAT_HEAD = [
  'arm',
  'ok',
  'empty',
  'leak?',
  'handoff = base',
  ...MARKER_KEYS.filter((k) => k !== 'handoff').map((k) => `${k} = base`),
  'avg chars',
  'avg reasoning tok',
  'cached',
  'p50 ms',
  'p95 ms',
  'cost / 100 replies',
]

function markerDiff(a: Markers, b: Markers): string {
  return MARKER_KEYS.filter((k) => !sameValue(a[k], b[k]))
    .map((k) => `${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`)
    .join(', ')
}

async function runChat() {
  const { db, accountId, config } = await setup()
  const arms = readArms()
  const limit = numberFlag('limit', 60)
  const repeat = numberFlag('repeat', 1)
  const concurrency = numberFlag('concurrency', 3)
  const show = numberFlag('show', 20)

  const turns = await collectTurns(db, accountId, config, limit, numberFlag('per-conversation', 2), numberFlag('days', 30))
  console.log(`chat: ${turns.length} turns × ${arms.length} arms × ${repeat}`)

  const jobs = turns.flatMap((_, t) => arms.flatMap((arm) => Array.from({ length: repeat }, (_, rep) => ({ t, arm, rep }))))
  const runs: ChatRun[] = []
  await pool(jobs, concurrency, async ({ t, arm, rep }) => {
    const r = await captured(() =>
      generateReply({
        config: { ...config, model: arm.model, reasoningEffort: arm.reasoningEffort },
        systemPrompt: turns[t].systemPrompt,
        messages: turns[t].context,
      }),
    )
    runs.push({ turn: t, arm: armLabel(arm), model: arm.model, rep, result: r.value, error: r.error, calls: r.calls })
  })

  const baselineLabel = armLabel(arms[0])
  const lines: string[] = [
    `# Chat replay — ${new Date().toISOString()}`,
    '',
    `${turns.length} auto-reply turns from the last ${numberFlag('days', 30)} days, ${repeat} run(s) per arm. ` +
      `Baseline: **${baselineLabel}**, run here on the same inputs. The live per-turn notes (receipt, pricing, meters) ` +
      'cannot be rebuilt, so the quote turns are compared in `shadow-report`, not here. "leak?" counts replies that look like ' +
      'the model talking about its instructions — read them.',
    '',
    '## Summary',
    '',
    table(CHAT_HEAD, chatSummary(arms, runs, baselineLabel)),
    '',
  ]

  const base = (t: number) => runs.find((r) => r.arm === baselineLabel && r.turn === t && r.rep === 0)
  lines.push('## Decisions that differ from the baseline', '')
  for (let t = 0; t < turns.length; t++) {
    const b = base(t)
    if (!b?.result) continue
    for (const r of runs.filter((r) => r.turn === t && r.arm !== baselineLabel)) {
      const diff = r.result ? markerDiff(shadowMarkers(b.result), shadowMarkers(r.result)) : `failed: ${r.error}`
      if (diff) lines.push(`- turn ${t + 1} (${turns[t].conversationId}, ${turns[t].createdAt.slice(0, 16)}) **${r.arm}** — ${diff}`)
    }
  }
  lines.push('')

  lines.push(`## Side by side (first ${Math.min(show, turns.length)} turns)`, '')
  for (let t = 0; t < Math.min(show, turns.length); t++) {
    const turn = turns[t]
    lines.push(`### Turn ${t + 1} — ${turn.createdAt.slice(0, 16)}`, '')
    for (const m of turn.context.slice(-5, -1)) {
      lines.push(`> **${m.role === 'user' ? 'cliente' : 'negocio'}:** ${cell(m.content.slice(0, 400))}`)
    }
    lines.push('', `- **sent in prod:** ${cell(turn.sentText)}`)
    for (const r of runs.filter((r) => r.turn === t && r.rep === 0)) {
      const marks = r.result ? MARKER_KEYS.filter((k) => r.result![k]).map((k) => `${k}=${JSON.stringify(r.result![k])}`).join(' ') : ''
      lines.push(`- **${r.arm}:** ${r.result ? cell(r.result.text) : `_${r.error}_`}${marks ? ` \`${marks}\`` : ''}${leaks(r.result?.text) ? ' ⚠︎ leak?' : ''}`)
    }
    lines.push('')
  }

  writeReport('chat', lines.join('\n'), {
    // The 28k-character system prompt is the same on every turn; leave it out.
    turns: turns.map((t) => ({ conversationId: t.conversationId, createdAt: t.createdAt, sentText: t.sentText, context: t.context })),
    runs,
  })
}

// ------------------------------------------------------------
// shadow-report
// ------------------------------------------------------------

async function runShadowReport() {
  const { db, accountId } = await setup()
  const days = numberFlag('days', 14)
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const { data, error } = await db
    .from('ai_shadow_runs')
    .select('*')
    .eq('account_id', accountId)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
  if (error) throw error
  const rows = data ?? []
  if (rows.length === 0) {
    console.log(`No shadow runs in the last ${days} days. Is AI_SHADOW_ARMS set on the server?`)
    return
  }

  const { data: usage } = await db
    .from('ai_usage_log')
    .select('model, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens')
    .eq('account_id', accountId)
    .eq('mode', 'auto_reply')
    .gte('created_at', since)

  const lines: string[] = [
    `# Shadow runs — last ${days} days (${rows.length} candidate answers)`,
    '',
    'Each candidate answered a live turn on exactly the prompt and notes production used. Nothing it wrote was sent.',
    '',
  ]

  // What production itself cost over the same window, now that cached
  // and reasoning tokens are logged.
  const baselineRows: string[][] = []
  for (const model of [...new Set((usage ?? []).map((u) => u.model as string))]) {
    const mine = (usage ?? []).filter((u) => u.model === model)
    const costs = mine
      .map((u) => costUsd(model, { prompt: u.prompt_tokens, cached: u.cached_tokens ?? 0, completion: u.completion_tokens }))
      .filter((c): c is number => c != null)
    baselineRows.push([
      `${model} (production)`,
      String(mine.length),
      fmt(avg(mine.map((u) => u.reasoning_tokens ?? 0))),
      pct(mine.reduce((a, u) => a + (u.cached_tokens ?? 0), 0), mine.reduce((a, u) => a + u.prompt_tokens, 0)),
      usd(costs.length ? avg(costs)! * 100 : null),
    ])
  }

  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = `${r.model}:${r.reasoning_effort ?? 'default'}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }

  const head = ['arm', 'answers', 'errors', 'leak?', ...MARKER_KEYS.map((k) => `${k} = prod`), 'avg chars (prod)', 'avg reasoning tok', 'cached', 'p50 / p95 ms', 'prod p50 / p95 ms', 'cost / 100 replies']
  const summary: string[][] = []
  for (const [label, mine] of groups) {
    const ok = mine.filter((r) => r.shadow_markers)
    const agree = (k: keyof Markers) => pct(ok.filter((r) => sameValue(r.baseline_markers[k], r.shadow_markers[k])).length, ok.length)
    const costs = ok
      .map((r) => costUsd(r.model, { prompt: r.prompt_tokens ?? 0, cached: r.cached_tokens ?? 0, completion: r.completion_tokens ?? 0 }))
      .filter((c): c is number => c != null)
    summary.push([
      label,
      String(mine.length),
      String(mine.length - ok.length),
      String(ok.filter((r) => leaks(r.shadow_text)).length),
      ...MARKER_KEYS.map(agree),
      `${fmt(avg(ok.map((r) => (r.shadow_text ?? '').length)))} (${fmt(avg(ok.map((r) => r.baseline_text.length)))})`,
      fmt(avg(ok.map((r) => r.reasoning_tokens ?? 0))),
      pct(ok.reduce((a, r) => a + (r.cached_tokens ?? 0), 0), ok.reduce((a, r) => a + (r.prompt_tokens ?? 0), 0)),
      `${fmt(percentile(ok.map((r) => r.shadow_latency_ms), 50))} / ${fmt(percentile(ok.map((r) => r.shadow_latency_ms), 95))}`,
      `${fmt(percentile(mine.map((r) => r.baseline_latency_ms), 50))} / ${fmt(percentile(mine.map((r) => r.baseline_latency_ms), 95))}`,
      usd(costs.length ? avg(costs)! * 100 : null),
    ])
  }

  lines.push(
    '## Candidates',
    '',
    table(head, summary),
    '',
    '## Production over the same window',
    '',
    table(['model', 'replies', 'avg reasoning tok', 'cached', 'cost / 100 replies'], baselineRows),
    '',
    '## Every decision that differs from production',
    '',
  )
  for (const r of rows) {
    const diff = r.shadow_markers ? markerDiff(r.baseline_markers, r.shadow_markers) : `failed: ${r.error}`
    const leak = leaks(r.shadow_text)
    if (!diff && !leak) continue
    lines.push(
      `### ${r.created_at.slice(0, 16)} — ${r.model}:${r.reasoning_effort ?? 'default'} — conversation ${r.conversation_id}`,
      '',
      `${diff || 'same decisions'}${leak ? ' — ⚠︎ leak?' : ''}`,
      '',
      `- **prod (${r.baseline_model}):** ${cell(r.baseline_text)}`,
      `- **candidate:** ${cell(r.shadow_text ?? `_${r.error}_`)}`,
      '',
    )
  }

  writeReport('shadow', lines.join('\n'), rows)
}

// ------------------------------------------------------------

const MODES: Record<string, () => Promise<void>> = {
  vision: runVision,
  chat: runChat,
  'shadow-report': runShadowReport,
}

const run = MODES[MODE]
if (!run) {
  console.error('Usage: npx tsx scripts/eval-models.ts <vision|chat|shadow-report> [--arm model:effort ...]')
  process.exit(1)
}
run().catch((err) => {
  console.error(err)
  process.exit(1)
})
