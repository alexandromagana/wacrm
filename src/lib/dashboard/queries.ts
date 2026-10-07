import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildReplyQueue,
  summarizeFollowUps,
  type FollowUpDealRow,
  type ReplyQueueRow,
} from './attention'
import {
  daysAgoStart,
  DOW_SHORT_MON_FIRST,
  lastNDayKeys,
  localDayKey,
  mondayIndex,
  startOfLocalDay,
} from './date-utils'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  FailedSend,
  FailingAutomation,
  FollowUpSummary,
  HealthSummary,
  MetricsBundle,
  PipelineDonutData,
  PipelineStageSlice,
  ReplyQueue,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from './types'

// ------------------------------------------------------------
// All client-side aggregation. RLS scopes every query to the
// signed-in user automatically, so we never pass user_id explicitly
// here. Perf is acceptable for the current scale (low thousands of
// messages) — if a tenant's dataset outgrows this, we'd migrate the
// heavy aggregations to SQL RPCs. Noted in the PR.
// ------------------------------------------------------------

type DB = SupabaseClient

// --- 1. Metric cards ---------------------------------------------------

export async function loadMetrics(db: DB): Promise<MetricsBundle> {
  const todayStart = startOfLocalDay().toISOString()
  const yesterdayStart = daysAgoStart(1).toISOString()

  const [
    openConvCur,
    newConvToday,
    newConvYesterday,
    newContactsToday,
    newContactsYesterday,
    openDeals,
    messagesToday,
    messagesYesterday,
  ] = await Promise.all([
    db.from('conversations').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .gte('created_at', todayStart),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
    db.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),
    db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
    db.from('deals').select('value, status').eq('status', 'open'),
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_type', 'agent')
      .gte('created_at', todayStart),
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_type', 'agent')
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
  ])

  const openDealsRows = (openDeals.data ?? []) as { value: number | null }[]
  const openDealsValue = openDealsRows.reduce((sum, d) => sum + (d.value ?? 0), 0)

  return {
    activeConversations: {
      current: openConvCur.count ?? 0,
      // "vs yesterday" on a current-state count has no clean answer
      // without snapshots — we show the delta in NEW open conversations
      // today vs yesterday. That's the business-meaningful daily signal.
      previous: (newConvToday.count ?? 0) - (newConvYesterday.count ?? 0),
    },
    newContactsToday: {
      current: newContactsToday.count ?? 0,
      previous: newContactsYesterday.count ?? 0,
    },
    openDealsValue,
    openDealsCount: openDealsRows.length,
    messagesSentToday: {
      current: messagesToday.count ?? 0,
      previous: messagesYesterday.count ?? 0,
    },
  }
}

// --- 2. Conversations over time ---------------------------------------

export async function loadConversationsSeries(
  db: DB,
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const start = daysAgoStart(rangeDays - 1).toISOString()
  const { data, error } = await db
    .from('messages')
    .select('created_at, sender_type')
    .gte('created_at', start)
    .order('created_at', { ascending: true })
  if (error) throw error

  const keys = lastNDayKeys(rangeDays)
  const buckets = new Map<string, { incoming: number; outgoing: number }>()
  for (const k of keys) buckets.set(k, { incoming: 0, outgoing: 0 })

  for (const row of (data ?? []) as { created_at: string; sender_type: string }[]) {
    const key = localDayKey(row.created_at)
    const bucket = buckets.get(key)
    if (!bucket) continue
    if (row.sender_type === 'customer') bucket.incoming += 1
    else bucket.outgoing += 1 // agent + bot both count as outgoing
  }

  return keys.map((day) => ({ day, ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }) }))
}

// --- 3. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(db: DB): Promise<PipelineDonutData> {
  const [stagesRes, dealsRes] = await Promise.all([
    db.from('pipeline_stages').select('id, name, color, pipeline_id, position').order('position'),
    db.from('deals').select('stage_id, value, status').eq('status', 'open'),
  ])

  const stages =
    (stagesRes.data ?? []) as { id: string; name: string; color: string }[]
  const deals = (dealsRes.data ?? []) as { stage_id: string; value: number | null }[]

  const byStage = new Map<string, { count: number; total: number }>()
  for (const d of deals) {
    const row = byStage.get(d.stage_id) ?? { count: 0, total: 0 }
    row.count += 1
    row.total += d.value ?? 0
    byStage.set(d.stage_id, row)
  }

  const slices: PipelineStageSlice[] = stages
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color || '#64748b',
      dealCount: byStage.get(s.id)?.count ?? 0,
      totalValue: byStage.get(s.id)?.total ?? 0,
    }))
    // Hide empty stages from the ring (but we'd still show them in the
    // legend if the user wanted a full breakdown — trimming keeps the
    // visual clean for the common case).
    .filter((s) => s.totalValue > 0 || s.dealCount > 0)

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  }
}

// --- 4. Response time by day of week ----------------------------------

export async function loadResponseTime(db: DB): Promise<ResponseTimeSummary> {
  // Pull the last 14 days of messages in one shot, then walk per
  // conversation to find each "first inbound" → "first subsequent
  // outbound" pair. 14 days gives us both "this week" + "last week"
  // with enough overlap if the user opens the dashboard late on a
  // Monday.
  const fourteenDaysAgo = daysAgoStart(13).toISOString()
  const { data, error } = await db
    .from('messages')
    .select('conversation_id, sender_type, created_at')
    .gte('created_at', fourteenDaysAgo)
    .order('conversation_id', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error

  const rows = (data ?? []) as {
    conversation_id: string
    sender_type: string
    created_at: string
  }[]

  // Group per conversation, pair unreplied customer messages with the
  // next outbound message from the agent/bot. A single customer message
  // can only count once (avoids inflating averages if the customer
  // double-messages while the agent takes time to reply).
  interface Sample {
    customerAt: Date
    responseAt: Date
  }
  const samples: Sample[] = []

  let currentConv = ''
  let pendingCustomer: Date | null = null
  for (const row of rows) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id
      pendingCustomer = null
    }
    const ts = new Date(row.created_at)
    if (row.sender_type === 'customer') {
      if (!pendingCustomer) pendingCustomer = ts
    } else if (pendingCustomer) {
      samples.push({ customerAt: pendingCustomer, responseAt: ts })
      pendingCustomer = null
    }
  }

  const now = new Date()
  const thisWeekStart = daysAgoStart(mondayIndex(now))
  const lastWeekStart = daysAgoStart(mondayIndex(now) + 7)

  // Per-day-of-week buckets, averaged over both weeks' worth of data
  // so each bar has more samples to stand on. If a day has no samples
  // its avgMinutes stays null and the chart renders the bar muted.
  const byDow = new Map<number, number[]>()
  for (let i = 0; i < 7; i++) byDow.set(i, [])
  const thisWeekMins: number[] = []
  const lastWeekMins: number[] = []

  for (const s of samples) {
    const diffMin = (s.responseAt.getTime() - s.customerAt.getTime()) / 60_000
    if (diffMin < 0) continue
    const dow = mondayIndex(s.customerAt)
    byDow.get(dow)!.push(diffMin)
    if (s.customerAt >= thisWeekStart) {
      thisWeekMins.push(diffMin)
    } else if (s.customerAt >= lastWeekStart && s.customerAt < thisWeekStart) {
      lastWeekMins.push(diffMin)
    }
  }

  const avg = (arr: number[]) =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length

  const buckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => {
    const samples = byDow.get(dow) ?? []
    return {
      dow,
      avgMinutes: avg(samples),
      samples: samples.length,
    }
  })

  // Silence unused-label warnings — keep the arrays explicitly named
  // for readability above.
  void DOW_SHORT_MON_FIRST

  return {
    buckets,
    thisWeekAvg: avg(thisWeekMins),
    lastWeekAvg: avg(lastWeekMins),
  }
}

// --- 5. Activity feed --------------------------------------------------

export async function loadActivity(db: DB, limit = 20): Promise<ActivityItem[]> {
  // Pull ~10 from each source (plenty of headroom after merge-sort),
  // then interleave by timestamp. The individual per-table limits
  // keep the payload small; the final limit is enforced after sort.
  const [msgs, contacts, deals, broadcasts, autoLogs] = await Promise.all([
    db
      .from('messages')
      .select('id, content_text, sender_type, created_at, conversation_id, conversations(contact_id, contacts(name, phone))')
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('contacts')
      .select('id, name, phone, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('deals')
      .select('id, title, updated_at, stage:pipeline_stages(name)')
      .order('updated_at', { ascending: false })
      .limit(10),
    db
      .from('broadcasts')
      .select('id, name, status, total_recipients, created_at')
      .order('created_at', { ascending: false })
      .limit(5),
    db
      .from('automation_logs')
      .select('id, trigger_event, status, created_at, automation:automations(name), contact:contacts(name, phone)')
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const items: ActivityItem[] = []

  // PostgREST returns nested selections as arrays by default, even when
  // the foreign key is 1:1. We normalise by taking [0] on each level.
  for (const m of (msgs.data ?? []) as unknown as Array<{
    id: string
    content_text: string | null
    created_at: string
    conversation_id: string
    conversations:
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }[]
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }
      | null
  }>) {
    const conv = Array.isArray(m.conversations) ? m.conversations[0] : m.conversations
    const contact = Array.isArray(conv?.contacts) ? conv?.contacts[0] : conv?.contacts
    const who = contact?.name || contact?.phone || 'Unknown'
    items.push({
      id: `msg-${m.id}`,
      kind: 'message',
      text: `New message from ${who}`,
      at: m.created_at,
      href: `/inbox?c=${m.conversation_id}`,
    })
  }

  for (const c of (contacts.data ?? []) as Array<{ id: string; name: string | null; phone: string; created_at: string }>) {
    items.push({
      id: `contact-${c.id}`,
      kind: 'contact',
      text: `New contact: ${c.name || c.phone}`,
      at: c.created_at,
      href: '/contacts',
    })
  }

  for (const d of (deals.data ?? []) as unknown as Array<{
    id: string
    title: string
    updated_at: string
    stage: { name: string }[] | { name: string } | null
  }>) {
    const stage = Array.isArray(d.stage) ? d.stage[0] : d.stage
    items.push({
      id: `deal-${d.id}`,
      kind: 'deal',
      text: stage?.name
        ? `Deal "${d.title}" in ${stage.name}`
        : `Deal "${d.title}" updated`,
      at: d.updated_at,
      href: '/pipelines',
    })
  }

  for (const b of (broadcasts.data ?? []) as Array<{
    id: string
    name: string
    status: string
    total_recipients: number
    created_at: string
  }>) {
    const label =
      b.status === 'sent'
        ? `sent to ${b.total_recipients} contacts`
        : `${b.status} (${b.total_recipients} recipients)`
    items.push({
      id: `broadcast-${b.id}`,
      kind: 'broadcast',
      text: `Broadcast "${b.name}" ${label}`,
      at: b.created_at,
      href: '/broadcasts',
    })
  }

  for (const l of (autoLogs.data ?? []) as unknown as Array<{
    id: string
    trigger_event: string
    status: string
    created_at: string
    automation: { name: string }[] | { name: string } | null
    contact: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null
  }>) {
    const automation = Array.isArray(l.automation) ? l.automation[0] : l.automation
    const contact = Array.isArray(l.contact) ? l.contact[0] : l.contact
    const who = contact?.name || contact?.phone || 'a contact'
    const autoName = automation?.name || 'Automation'
    items.push({
      id: `auto-${l.id}`,
      kind: 'automation',
      text: `Automation "${autoName}" ${l.status === 'failed' ? 'failed for' : 'triggered for'} ${who}`,
      at: l.created_at,
      failed: l.status === 'failed',
    })
  }

  return items
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
    .slice(0, limit)
}

// --- 6. Reply queue ----------------------------------------------------

export async function loadReplyQueue(db: DB): Promise<ReplyQueue> {
  const [convRes, profilesRes] = await Promise.all([
    db
      .from('conversations')
      .select(
        'id, assigned_agent_id, last_customer_message_at, last_message_text, ai_autoreply_disabled, ai_handoff_summary, contact:contacts(name, phone), messages(sender_type, created_at)',
        { count: 'exact' },
      )
      .neq('status', 'closed')
      // Only each thread's newest message: that is all "who spoke
      // last" needs, and it keeps the payload one row per thread.
      .order('created_at', { referencedTable: 'messages', ascending: false })
      .limit(1, { referencedTable: 'messages' }),
    db.from('profiles').select('user_id, full_name'),
  ])
  if (convRes.error) throw convRes.error

  // Names are a nicety for the owner column; without them the row
  // still says it has an owner, so a failed lookup isn't fatal.
  const agentNames: Record<string, string> = {}
  for (const p of (profilesRes.data ?? []) as { user_id: string; full_name: string | null }[]) {
    if (p.full_name) agentNames[p.user_id] = p.full_name
  }

  const rows = (convRes.data ?? []) as unknown as ReplyQueueRow[]
  return {
    items: buildReplyQueue(rows),
    activeCount: convRes.count ?? rows.length,
    agentNames,
  }
}

// --- 7. Pipeline follow-ups --------------------------------------------

export async function loadFollowUps(db: DB): Promise<FollowUpSummary> {
  const [dealsRes, suggestedRes] = await Promise.all([
    db
      .from('deals')
      .select('technical_visit_at, installation_date, quoted_at')
      .eq('status', 'open'),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .neq('status', 'closed')
      .not('close_suggested_at', 'is', null),
  ])
  if (dealsRes.error) throw dealsRes.error
  if (suggestedRes.error) throw suggestedRes.error

  return {
    ...summarizeFollowUps((dealsRes.data ?? []) as FollowUpDealRow[]),
    closeSuggested: suggestedRes.count ?? 0,
  }
}

// --- 8. Delivery + automation health -----------------------------------

/** Failed sends listed by name on the dashboard; the count covers the rest. */
const RECENT_FAILED_SENDS = 5

type OneOrMany<T> = T | T[] | null

export async function loadHealth(db: DB, accountId: string | null): Promise<HealthSummary> {
  // Seven local days including today, the same window the 7-day chart uses.
  const since = daysAgoStart(6).toISOString()
  const count = { count: 'exact' as const, head: true }

  const [config, failedSends, outbound, failedList, failedRunRows, totalRuns, failedBroadcasts] =
    await Promise.all([
      accountId
        ? db.from('whatsapp_config').select('status').eq('account_id', accountId).maybeSingle()
        : Promise.resolve(null),
      db
        .from('messages')
        .select('id', count)
        .neq('sender_type', 'customer')
        .eq('status', 'failed')
        .gte('created_at', since),
      db.from('messages').select('id', count).neq('sender_type', 'customer').gte('created_at', since),
      // A count alone left nowhere to go: these are the rows behind it,
      // so each one can link to the conversation it failed in.
      db
        .from('messages')
        .select(
          'id, conversation_id, created_at, content_type, status_error, conversation:conversations(contact:contacts(name, phone))',
        )
        .neq('sender_type', 'customer')
        .eq('status', 'failed')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(RECENT_FAILED_SENDS),
      db
        .from('automation_logs')
        .select('automation_id, automation:automations(name)')
        .eq('status', 'failed')
        .gte('created_at', since),
      db.from('automation_logs').select('id', count).gte('created_at', since),
      db.from('broadcasts').select('id', count).eq('status', 'failed').gte('created_at', since),
    ])

  for (const res of [failedSends, outbound, failedList, failedRunRows, totalRuns, failedBroadcasts]) {
    if (res.error) throw res.error
  }

  const recentFailedSends: FailedSend[] = []
  for (const m of (failedList.data ?? []) as unknown as Array<{
    id: string
    conversation_id: string
    created_at: string
    content_type: string
    status_error: string | null
    conversation:
      | { contact: OneOrMany<{ name: string | null; phone: string }> }
      | { contact: OneOrMany<{ name: string | null; phone: string }> }[]
      | null
  }>) {
    const conv = Array.isArray(m.conversation) ? m.conversation[0] : m.conversation
    const contact = Array.isArray(conv?.contact) ? conv?.contact[0] : conv?.contact
    recentFailedSends.push({
      messageId: m.id,
      conversationId: m.conversation_id,
      contactName: contact?.name || contact?.phone || '',
      at: m.created_at,
      contentType: m.content_type,
      reason: m.status_error,
    })
  }

  const byAutomation = new Map<string, FailingAutomation>()
  for (const row of (failedRunRows.data ?? []) as unknown as Array<{
    automation_id: string
    automation: { name: string } | { name: string }[] | null
  }>) {
    const automation = Array.isArray(row.automation) ? row.automation[0] : row.automation
    const entry = byAutomation.get(row.automation_id) ?? {
      automationId: row.automation_id,
      name: automation?.name ?? '',
      failedRuns: 0,
    }
    entry.failedRuns += 1
    byAutomation.set(row.automation_id, entry)
  }
  const failingAutomations = [...byAutomation.values()].sort((a, b) => b.failedRuns - a.failedRuns)

  // Same reading as the Inbox banner: no config row means not connected.
  const whatsapp =
    !config || config.error
      ? 'unknown'
      : config.data?.status === 'connected'
        ? 'connected'
        : 'disconnected'

  return {
    whatsapp,
    failedSends: failedSends.count ?? 0,
    outboundMessages: outbound.count ?? 0,
    recentFailedSends,
    failedRuns: (failedRunRows.data ?? []).length,
    totalRuns: totalRuns.count ?? 0,
    failingAutomations,
    failedBroadcasts: failedBroadcasts.count ?? 0,
  }
}
