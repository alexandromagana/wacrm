import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { isBusinessHours } from './business-hours'
import { getSweepMode, LIFECYCLE_CONFIG, type LifecycleConfig } from './config'
import { executeDecision, type ActionOutcome } from './execute'
import { loadRecentReminders, loadSenders, loadSnapshots } from './load'
import { decideLifecycleAction, type LifecycleAction } from './rules'

/**
 * The lifecycle sweep: close prospects that went silent, remind leads
 * that never sent their bill, and flag chats a person owns as ready to
 * close. Rules live in rules.ts, timings in config.ts.
 *
 * It runs from the automations cron (maybeRunLifecycleSweep) and from
 * scripts/lifecycle-backlog.ts, which prints the same decisions as a
 * list to review before the sweep is switched on.
 */

export interface SweepReportRow {
  accountId: string
  conversationId: string
  contactId: string
  dealId: string | null
  contactName: string | null
  /** Last 4 digits only — the report is meant to be shared for review. */
  phoneLast4: string | null
  stage: string | null
  silentDays: number
  assigned: boolean
  action: Exclude<LifecycleAction, 'none'>
  reason: string
  outcome: ActionOutcome
  detail?: Record<string, unknown>
}

export interface SweepSummary {
  considered: number
  remind: number
  close: number
  suggest: number
  failed: number
  skipped: number
}

export interface SweepOptions {
  mode: 'dry_run' | 'apply'
  now?: Date
  cfg?: LifecycleConfig
  /** Per-run limits; null for none (the backlog report wants every row). */
  caps?: LifecycleConfig['caps'] | null
  /** Report reminders as due regardless of the clock (backlog report). */
  ignoreBusinessHours?: boolean
  /** Write each decision to lifecycle_actions under this run. */
  runId?: string | null
  db?: SupabaseClient
}

export async function runLifecycleSweep(
  opts: SweepOptions,
): Promise<{ rows: SweepReportRow[]; summary: SweepSummary }> {
  const db = opts.db ?? supabaseAdmin()
  const cfg = opts.cfg ?? LIFECYCLE_CONFIG
  const now = opts.now ?? new Date()
  const caps = opts.caps === undefined ? cfg.caps : opts.caps
  const inBusinessHours = opts.ignoreBusinessHours || isBusinessHours(now, cfg.businessHours)

  const [snapshots, senders, recentReminders] = await Promise.all([
    loadSnapshots(db, cfg, now),
    loadSenders(db),
    loadRecentReminders(db, now),
  ])

  const decided = snapshots
    .map((snap) => ({ snap, decision: decideLifecycleAction(snap, now, cfg, { inBusinessHours }) }))
    .filter((d) => d.decision.action !== 'none')
    // Freshest silences first: when a cap cuts the run short, the leads
    // most likely to still answer get their reminder today.
    .sort((a, b) => a.decision.silentDays - b.decision.silentDays)

  const rows: SweepReportRow[] = []
  const summary: SweepSummary = {
    considered: snapshots.length,
    remind: 0,
    close: 0,
    suggest: 0,
    failed: 0,
    skipped: 0,
  }
  let reminders = 0
  let closes = 0

  for (const { snap, decision } of decided) {
    const action = decision.action as SweepReportRow['action']
    let outcome: ActionOutcome = 'skipped'
    let detail: Record<string, unknown> | undefined

    if (action === 'remind' && recentReminders.has(snap.conversationId)) {
      detail = { why: 'reminded_in_last_24h' }
    } else if (action === 'remind' && caps && reminders >= caps.reminders) {
      detail = { why: 'cap' }
    } else if (action === 'close' && caps && closes >= caps.closes) {
      detail = { why: 'cap' }
    } else if (opts.mode === 'dry_run') {
      detail = { dry_run: true }
      if (action === 'remind') reminders += 1
      if (action === 'close') closes += 1
    } else {
      const result = await executeDecision(db, snap, decision, cfg, senders.get(snap.accountId))
      outcome = result.outcome
      detail = result.detail
      if (outcome !== 'skipped' && action === 'remind') reminders += 1
      if (outcome === 'done' && action === 'close') closes += 1
    }

    if (outcome === 'failed') summary.failed += 1
    else if (outcome === 'skipped' && !detail?.dry_run) summary.skipped += 1
    else summary[action] += 1

    const phoneDigits = snap.contactPhone?.replace(/\D/g, '') ?? ''
    rows.push({
      accountId: snap.accountId,
      conversationId: snap.conversationId,
      contactId: snap.contactId,
      dealId: snap.deal?.id ?? null,
      contactName: snap.contactName,
      phoneLast4: phoneDigits ? phoneDigits.slice(-4) : null,
      stage: snap.deal?.stageName ?? null,
      silentDays: decision.silentDays,
      assigned: Boolean(snap.assignedAgentId),
      action,
      reason: decision.reason,
      outcome,
      detail,
    })
  }

  if (opts.runId && rows.length > 0) {
    const { error } = await db.from('lifecycle_actions').insert(
      rows.map((r) => ({
        run_id: opts.runId,
        account_id: r.accountId,
        conversation_id: r.conversationId,
        contact_id: r.contactId,
        deal_id: r.dealId,
        action: r.action,
        reason: r.reason,
        outcome: r.outcome,
        detail: r.detail ?? null,
      })),
    )
    if (error) console.error('[lifecycle] failed to record actions:', error.message)
  }

  return { rows, summary }
}

/**
 * Cron entry point. Does nothing unless LIFECYCLE_SWEEP is `dry_run` or
 * `apply`, and runs at most once per `runIntervalMinutes`: the unique
 * `slot` on lifecycle_runs lets exactly one of the 5-minute cron calls
 * in each window through, and keeps two from overlapping.
 */
export async function maybeRunLifecycleSweep(now = new Date()): Promise<void> {
  const mode = getSweepMode()
  if (mode === 'off') return

  const db = supabaseAdmin()
  const slot = Math.floor(now.getTime() / (LIFECYCLE_CONFIG.runIntervalMinutes * 60_000))
  const { data: run, error } = await db
    .from('lifecycle_runs')
    .insert({ mode, source: 'cron', slot })
    .select('id')
    .single()
  if (error) {
    // 23505: another call already took this window.
    if (error.code !== '23505') console.error('[lifecycle] could not start run:', error.message)
    return
  }

  try {
    const { summary } = await runLifecycleSweep({ mode, now, runId: run.id, db })
    await db
      .from('lifecycle_runs')
      .update({ finished_at: new Date().toISOString(), summary })
      .eq('id', run.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[lifecycle] sweep failed:', message)
    await db
      .from('lifecycle_runs')
      .update({ finished_at: new Date().toISOString(), summary: { error: message } })
      .eq('id', run.id)
  }
}
