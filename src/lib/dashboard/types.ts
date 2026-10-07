// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  openDealsValue: number
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  totalValue: number
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  totalValue: number
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
}

/** One conversation where the customer wrote last and nobody has answered. */
export interface ReplyQueueItem {
  conversationId: string
  /** Contact name, falling back to the phone number. */
  contactName: string
  /** `conversations.last_message_text` — the customer's, by definition. */
  preview: string | null
  /** When the customer wrote. Drives "waiting" and the 24h window. */
  customerAt: string
  /** Whole hours left in WhatsApp's 24h window, truncated the way the
   *  inbox's badge shows it; null once it has lapsed and only a
   *  template will send. */
  hoursLeft: number | null
  assignedAgentId: string | null
  /** The bot paused itself on this thread and left a handoff note. */
  handedOff: boolean
}

export interface ReplyQueue {
  /** Open-window threads first (least time left first), then lapsed
   *  ones, newest first. */
  items: ReplyQueueItem[]
  /** Every non-closed conversation — the universe the queue is drawn from. */
  activeCount: number
  /** user_id → display name, for the owner column. */
  agentNames: Record<string, string>
}

/** Pipeline follow-ups, all over open deals and as of now. */
export interface FollowUpSummary {
  openDeals: number
  /** A quote went out (`quoted_at`) and the deal is neither won nor lost. */
  quotedOpen: number
  /** The site visit date has passed and no install date is set. */
  visitDoneNoInstall: number
  visitsNext7: number
  installsNext7: number
  /** Non-closed chats the lifecycle sweep flagged as ready to close —
   *  the same rule as the Inbox's "Stale" tile. */
  closeSuggested: number
}

export type WhatsAppLinkState = 'connected' | 'disconnected' | 'unknown'

/** One outbound message WhatsApp refused, with where to find it. */
export interface FailedSend {
  messageId: string
  conversationId: string
  contactName: string
  at: string
  contentType: string
  /** Meta's reason (`messages.status_error`), when it gave one. */
  reason: string | null
}

/** An automation with failed runs in the window, for a logs link. */
export interface FailingAutomation {
  automationId: string
  name: string
  failedRuns: number
}

/** Delivery and automation incidents over the last 7 days. */
export interface HealthSummary {
  whatsapp: WhatsAppLinkState
  failedSends: number
  /** Messages sent by agents or the bot — the universe for failedSends. */
  outboundMessages: number
  /** The most recent failed sends (capped), newest first. */
  recentFailedSends: FailedSend[]
  failedRuns: number
  totalRuns: number
  /** Which automations the failed runs belong to, most failures first. */
  failingAutomations: FailingAutomation[]
  failedBroadcasts: number
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
  /** Set when the event is a failure (a failed automation run). */
  failed?: boolean
}
