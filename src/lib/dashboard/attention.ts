import { dealMilestones } from '@/lib/deals/milestones'
import { getWhatsAppSessionInfo } from '@/lib/whatsapp/session-window'
import type { FollowUpSummary, ReplyQueueItem } from './types'

// ------------------------------------------------------------
// Pure shaping for the dashboard's "what needs attention" blocks.
// queries.ts fetches the rows; these decide what counts and in what
// order, so the rules are testable without a database.
// ------------------------------------------------------------

type OneOrMany<T> = T | T[] | null

function first<T>(value: OneOrMany<T> | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export interface ReplyQueueRow {
  id: string
  assigned_agent_id: string | null
  last_customer_message_at: string | null
  last_message_text: string | null
  ai_autoreply_disabled: boolean | null
  ai_handoff_summary: string | null
  contact: OneOrMany<{ name: string | null; phone: string }>
  /** The thread's newest message only (embedded with limit 1). */
  messages: { sender_type: string; created_at: string }[] | null
}

/**
 * Conversations whose newest message came from the customer.
 *
 * Who spoke last is read off the newest message itself, not by
 * comparing `last_customer_message_at` with `last_message_at`: the
 * webhook stamps the first with Meta's clock and the second with ours,
 * so on a customer-last thread the two are seconds apart and the
 * comparison misfires both ways.
 *
 * Order is by what can still be done: threads inside WhatsApp's 24h
 * window come first, the one closing soonest on top (after that only a
 * template will send). Lapsed threads follow newest first — a lead who
 * wrote yesterday is likelier to come back than one from last month.
 */
export function buildReplyQueue(
  rows: ReplyQueueRow[],
  now: Date = new Date(),
): ReplyQueueItem[] {
  const items: ReplyQueueItem[] = []
  for (const row of rows) {
    const newest = row.messages?.[0]
    if (!newest || newest.sender_type !== 'customer') continue

    const customerAt = row.last_customer_message_at ?? newest.created_at
    const session = getWhatsAppSessionInfo(customerAt, now)
    const hoursLeft =
      session.remaining.kind === 'hoursRemaining'
        ? session.remaining.hours
        : session.remaining.kind === 'minutesRemaining'
          ? 0
          : null

    const contact = first(row.contact)
    items.push({
      conversationId: row.id,
      contactName: contact?.name || contact?.phone || '',
      preview: row.last_message_text,
      customerAt,
      hoursLeft,
      assignedAgentId: row.assigned_agent_id,
      handedOff: !!row.ai_autoreply_disabled && !!row.ai_handoff_summary,
    })
  }

  const at = (i: ReplyQueueItem) => Date.parse(i.customerAt)
  const open = items.filter((i) => i.hoursLeft !== null).sort((a, b) => at(a) - at(b))
  const lapsed = items.filter((i) => i.hoursLeft === null).sort((a, b) => at(b) - at(a))
  return [...open, ...lapsed]
}

export interface FollowUpDealRow {
  technical_visit_at: string | null
  installation_date: string | null
  quoted_at: string | null
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Counts over open deals. `closeSuggested` comes from its own query. */
export function summarizeFollowUps(
  deals: FollowUpDealRow[],
  now: Date = new Date(),
): Omit<FollowUpSummary, 'closeSuggested'> {
  const weekEnd = now.getTime() + WEEK_MS
  // Installs are booked by day (parsed to local noon), so one later
  // today is still ahead of the crew even once noon has passed.
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  let quotedOpen = 0
  let visitDoneNoInstall = 0
  let visitsNext7 = 0
  let installsNext7 = 0

  for (const deal of deals) {
    if (deal.quoted_at) quotedOpen += 1
    const milestones = dealMilestones(deal, now)
    const visit = milestones.find((m) => m.kind === 'visit')
    const install = milestones.find((m) => m.kind === 'installation')
    if (visit?.past && !install) visitDoneNoInstall += 1
    for (const m of milestones) {
      const ahead = m.kind === 'installation' ? m.date >= todayStart : !m.past
      if (!ahead || m.date.getTime() >= weekEnd) continue
      if (m.kind === 'visit') visitsNext7 += 1
      else installsNext7 += 1
    }
  }

  return {
    openDeals: deals.length,
    quotedOpen,
    visitDoneNoInstall,
    visitsNext7,
    installsNext7,
  }
}
