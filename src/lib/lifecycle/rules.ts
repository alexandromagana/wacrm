import type { AutoLostReason } from '@/lib/deals/lost-reasons'
import type { LifecycleConfig } from './config'

/**
 * Everything the rules need to know about one open conversation. Built
 * by load.ts from a handful of batched queries; pure data so the rules
 * can be tested without a database.
 */
export interface LifecycleSnapshot {
  accountId: string
  conversationId: string
  contactId: string
  contactName: string | null
  contactPhone: string | null
  status: 'open' | 'pending' | 'closed'
  assignedAgentId: string | null
  /** conversations.last_customer_message_at — null if they never wrote. */
  lastCustomerMessageAt: string | null
  conversationCreatedAt: string
  closeSuggestedAt: string | null
  closeSuggestionDismissedAt: string | null
  /** Has the exemption tag ("No cerrar"). */
  exempt: boolean
  /** The contact's newest open deal, if any. */
  deal: {
    id: string
    stageId: string
    stageName: string
    autoClose: boolean
    isFirstStage: boolean
    quotedAt: string | null
    quoteUrl: string | null
  } | null
  hasWonDeal: boolean
  /** An automation run is still waiting to fire for this contact. */
  hasPendingAutomation: boolean
  /** Latest follow-up template (`seguimiento_coti` / `sin_respuesta`) sent. */
  lastFollowUpAt: string | null
  /** Latest receipt reminder template sent — chat or broadcast. */
  lastReminderAt: string | null
  /** The customer has sent an image or document (likely their bill). */
  customerSentMedia: boolean
}

export type LifecycleAction = 'none' | 'remind' | 'close' | 'suggest'

export interface LifecycleDecision {
  action: LifecycleAction
  /** Why: an `auto_*` reason for remind/close/suggest, a short code for none. */
  reason: string
  /** Whole days since the customer last wrote (or the chat started). */
  silentDays: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function ms(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function none(reason: string, silentDays: number): LifecycleDecision {
  return { action: 'none', reason, silentDays }
}

/**
 * Decide what to do with one conversation, in order:
 *
 *  1. Leave it alone if it is closed, exempt, has a won deal, sits in a
 *     stage the sweep may not touch, or still has an automation waiting
 *     (the follow-ups must finish first).
 *  2. Work out the due action:
 *     - Quoted (proposal link, quoted_at, or a follow-up went out):
 *       close once silent `quotedSilenceDays` since the later of their
 *       last message and the quote, and `afterFollowUpDays` since the
 *       last follow-up sent after their last message.
 *     - Never wrote: close `closeAfterReminderDays` after the reminder
 *       template reached them; nothing if it never did.
 *     - Not quoted, in the first stage (or no deal), no bill received:
 *       remind after `remindAfterDays`, close `closeAfterReminderDays`
 *       after the reminder — or close straight away past
 *       `directCloseAfterDays` with no reminder yet.
 *     - Anything else (sent a bill but got no quote, stuck mid-board):
 *       suggest after `suggestAfterDays`. No rule is confident enough.
 *  3. A chat a person owns is never messaged or closed: a due close
 *     becomes a suggestion, and a due reminder waits until
 *     `suggestAfterDays` and becomes one too. A suggestion is made once,
 *     and not again if someone dismissed it after the customer's last
 *     message.
 *
 * Reminders only go out in business hours; outside them the answer is
 * `none` and the next run tries again.
 */
export function decideLifecycleAction(
  snap: LifecycleSnapshot,
  now: Date,
  cfg: LifecycleConfig,
  opts: { inBusinessHours: boolean },
): LifecycleDecision {
  const nowMs = now.getTime()
  const last = ms(snap.lastCustomerMessageAt)
  const silentSince = last ?? ms(snap.conversationCreatedAt) ?? nowMs
  const silentMs = nowMs - silentSince
  const silentDays = Math.floor(silentMs / DAY_MS)

  if (snap.status === 'closed') return none('closed', silentDays)
  if (snap.exempt) return none('exempt', silentDays)
  if (snap.hasWonDeal) return none('won', silentDays)
  if (snap.deal && !snap.deal.autoClose) return none('protected_stage', silentDays)
  if (snap.hasPendingAutomation) return none('automation_pending', silentDays)

  const due = dueAction(snap, nowMs, last, silentMs, cfg)
  if (due.action === 'none') return { ...due, silentDays }

  if (snap.assignedAgentId) {
    if (due.action === 'remind' && silentMs < cfg.suggestAfterDays * DAY_MS) {
      return none('not_due', silentDays)
    }
    return suggestOrNone(snap, last, due.reason, silentDays)
  }

  if (due.action === 'suggest') return suggestOrNone(snap, last, due.reason, silentDays)
  if (due.action === 'remind' && !opts.inBusinessHours) return none('outside_hours', silentDays)
  return { ...due, silentDays }
}

function dueAction(
  snap: LifecycleSnapshot,
  nowMs: number,
  last: number | null,
  silentMs: number,
  cfg: LifecycleConfig,
): { action: LifecycleAction; reason: string } {
  const quotedAt = ms(snap.deal?.quotedAt)
  const lastFollowUp = ms(snap.lastFollowUpAt)
  const lastReminder = ms(snap.lastReminderAt)
  const quoted = quotedAt !== null || Boolean(snap.deal?.quoteUrl) || lastFollowUp !== null

  if (quoted) {
    const anchor = Math.max(last ?? 0, quotedAt ?? 0) || nowMs - silentMs
    if (nowMs - anchor < cfg.quotedSilenceDays * DAY_MS) return { action: 'none', reason: 'not_due' }
    const followUpAfterLast = lastFollowUp !== null && (last === null || lastFollowUp > last)
    if (followUpAfterLast && nowMs - lastFollowUp < cfg.afterFollowUpDays * DAY_MS) {
      return { action: 'none', reason: 'not_due' }
    }
    return { action: 'close', reason: 'auto_sin_respuesta_seguimientos' satisfies AutoLostReason }
  }

  if (last === null) {
    if (lastReminder !== null && nowMs - lastReminder >= cfg.closeAfterReminderDays * DAY_MS) {
      return { action: 'close', reason: 'auto_sin_contacto' satisfies AutoLostReason }
    }
    return { action: 'none', reason: 'never_wrote' }
  }

  const firstStage = !snap.deal || snap.deal.isFirstStage
  if (firstStage && !snap.customerSentMedia) {
    const remindedSinceLast = lastReminder !== null && lastReminder > last
    if (remindedSinceLast) {
      return nowMs - lastReminder >= cfg.closeAfterReminderDays * DAY_MS
        ? { action: 'close', reason: 'auto_sin_recibo' satisfies AutoLostReason }
        : { action: 'none', reason: 'not_due' }
    }
    if (silentMs >= cfg.directCloseAfterDays * DAY_MS) {
      return { action: 'close', reason: 'auto_sin_recibo' satisfies AutoLostReason }
    }
    if (silentMs >= cfg.remindAfterDays * DAY_MS) {
      return { action: 'remind', reason: 'auto_sin_recibo' satisfies AutoLostReason }
    }
    return { action: 'none', reason: 'not_due' }
  }

  return silentMs >= cfg.suggestAfterDays * DAY_MS
    ? { action: 'suggest', reason: 'auto_sin_respuesta' satisfies AutoLostReason }
    : { action: 'none', reason: 'not_due' }
}

function suggestOrNone(
  snap: LifecycleSnapshot,
  last: number | null,
  reason: string,
  silentDays: number,
): LifecycleDecision {
  if (snap.closeSuggestedAt) return none('already_suggested', silentDays)
  const dismissed = ms(snap.closeSuggestionDismissedAt)
  if (dismissed !== null && dismissed > (last ?? 0)) return none('suggestion_dismissed', silentDays)
  return { action: 'suggest', reason, silentDays }
}
