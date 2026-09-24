import type { SupabaseClient } from '@supabase/supabase-js'
import type { LifecycleConfig } from './config'
import type { LifecycleSnapshot } from './rules'

/**
 * Load a snapshot of every open or pending conversation, across all
 * accounts, in a fixed number of batched queries — never one query per
 * chat. The service-role client reads everything; each snapshot carries
 * its account id and the executor scopes every write by it.
 */

const PAGE = 1000
const CHUNK = 100

export interface RawConversation {
  id: string
  account_id: string
  contact_id: string
  status: 'open' | 'pending' | 'closed'
  assigned_agent_id: string | null
  last_customer_message_at: string | null
  created_at: string
  close_suggested_at: string | null
  close_suggestion_dismissed_at: string | null
  contact: { name: string | null; phone: string | null } | null
}

export interface RawDeal {
  id: string
  contact_id: string
  pipeline_id: string
  stage_id: string
  status: 'open' | 'won' | 'lost'
  quoted_at: string | null
  quote_url: string | null
  created_at: string
}

export interface RawStage {
  id: string
  pipeline_id: string
  name: string
  position: number
  auto_close: boolean
}

export interface SnapshotInputs {
  conversations: RawConversation[]
  /** contact id → tag names */
  tagsByContact: Map<string, string[]>
  deals: RawDeal[]
  stages: RawStage[]
  /** contacts with a live (not stuck) automation run waiting */
  pendingContacts: Set<string>
  /** conversation id → latest follow-up template sent */
  lastFollowUpByConversation: Map<string, string>
  /** conversation id → latest reminder template sent in the chat */
  lastReminderByConversation: Map<string, string>
  /** contact id → latest reminder template sent by broadcast */
  lastReminderByContact: Map<string, string>
  /** conversations where the customer sent an image or document */
  mediaConversations: Set<string>
  exemptTagName: string
}

function later(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

/** Pure: raw rows in, one snapshot per conversation out. */
export function buildSnapshots(input: SnapshotInputs): LifecycleSnapshot[] {
  const stageById = new Map(input.stages.map((s) => [s.id, s]))
  const firstStageByPipeline = new Map<string, RawStage>()
  for (const stage of input.stages) {
    const current = firstStageByPipeline.get(stage.pipeline_id)
    if (!current || stage.position < current.position) {
      firstStageByPipeline.set(stage.pipeline_id, stage)
    }
  }

  const openDealByContact = new Map<string, RawDeal>()
  const wonContacts = new Set<string>()
  for (const deal of input.deals) {
    if (deal.status === 'won') {
      wonContacts.add(deal.contact_id)
    } else if (deal.status === 'open') {
      const current = openDealByContact.get(deal.contact_id)
      if (!current || Date.parse(deal.created_at) > Date.parse(current.created_at)) {
        openDealByContact.set(deal.contact_id, deal)
      }
    }
  }

  const exempt = input.exemptTagName.trim().toLowerCase()

  return input.conversations.map((c) => {
    const deal = openDealByContact.get(c.contact_id)
    const stage = deal ? stageById.get(deal.stage_id) : undefined
    const tags = input.tagsByContact.get(c.contact_id) ?? []
    return {
      accountId: c.account_id,
      conversationId: c.id,
      contactId: c.contact_id,
      contactName: c.contact?.name ?? null,
      contactPhone: c.contact?.phone ?? null,
      status: c.status,
      assignedAgentId: c.assigned_agent_id,
      lastCustomerMessageAt: c.last_customer_message_at,
      conversationCreatedAt: c.created_at,
      closeSuggestedAt: c.close_suggested_at,
      closeSuggestionDismissedAt: c.close_suggestion_dismissed_at,
      exempt: tags.some((t) => t.trim().toLowerCase() === exempt),
      deal: deal
        ? {
            id: deal.id,
            stageId: deal.stage_id,
            stageName: stage?.name ?? '',
            // An unknown stage is treated as off-limits.
            autoClose: stage?.auto_close ?? false,
            isFirstStage: firstStageByPipeline.get(deal.pipeline_id)?.id === deal.stage_id,
            quotedAt: deal.quoted_at,
            quoteUrl: deal.quote_url,
          }
        : null,
      hasWonDeal: wonContacts.has(c.contact_id),
      hasPendingAutomation: input.pendingContacts.has(c.contact_id),
      lastFollowUpAt: input.lastFollowUpByConversation.get(c.id) ?? null,
      lastReminderAt: later(
        input.lastReminderByConversation.get(c.id),
        input.lastReminderByContact.get(c.contact_id),
      ),
      customerSentMedia: input.mediaConversations.has(c.id),
    }
  })
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function keepLatest(map: Map<string, string>, key: string, at: string) {
  const current = map.get(key)
  if (!current || Date.parse(at) > Date.parse(current)) map.set(key, at)
}

async function loadOpenConversations(db: SupabaseClient): Promise<RawConversation[]> {
  const rows: RawConversation[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('conversations')
      .select(
        'id, account_id, contact_id, status, assigned_agent_id, last_customer_message_at, created_at, close_suggested_at, close_suggestion_dismissed_at, contact:contacts(name, phone)',
      )
      .in('status', ['open', 'pending'])
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`conversations: ${error.message}`)
    rows.push(...((data ?? []) as unknown as RawConversation[]))
    if (!data || data.length < PAGE) return rows
  }
}

export async function loadSnapshots(
  db: SupabaseClient,
  cfg: LifecycleConfig,
  now: Date,
): Promise<LifecycleSnapshot[]> {
  const conversations = await loadOpenConversations(db)
  if (conversations.length === 0) return []

  const conversationIds = conversations.map((c) => c.id)
  const contactIds = [...new Set(conversations.map((c) => c.contact_id))]
  const reminderName = cfg.reminderTemplate.name
  const templateNames = [...cfg.followUpTemplates, reminderName]
  const followUps = new Set(cfg.followUpTemplates)
  const staleBefore = now.getTime() - cfg.staleRunningHours * 60 * 60 * 1000

  const tagsByContact = new Map<string, string[]>()
  const deals: RawDeal[] = []
  const pendingContacts = new Set<string>()
  const lastReminderByContact = new Map<string, string>()

  for (const ids of chunks(contactIds)) {
    const [tags, dealRows, pending, broadcasts] = await Promise.all([
      db.from('contact_tags').select('contact_id, tag:tags(name)').in('contact_id', ids),
      db
        .from('deals')
        .select('id, contact_id, pipeline_id, stage_id, status, quoted_at, quote_url, created_at')
        .in('contact_id', ids)
        .in('status', ['open', 'won']),
      db
        .from('automation_pending_executions')
        .select('contact_id, status, run_at')
        .in('contact_id', ids)
        .in('status', ['pending', 'running']),
      db
        .from('broadcast_recipients')
        .select('contact_id, sent_at, broadcast:broadcasts!inner(template_name)')
        .in('contact_id', ids)
        .eq('broadcast.template_name', reminderName)
        .not('sent_at', 'is', null),
    ])
    for (const r of [tags, dealRows, pending, broadcasts]) {
      if (r.error) throw new Error(`snapshot load: ${r.error.message}`)
    }

    for (const row of (tags.data ?? []) as unknown as Array<{
      contact_id: string
      tag: { name: string } | null
    }>) {
      if (!row.tag) continue
      const list = tagsByContact.get(row.contact_id) ?? []
      list.push(row.tag.name)
      tagsByContact.set(row.contact_id, list)
    }
    deals.push(...((dealRows.data ?? []) as RawDeal[]))
    for (const row of (pending.data ?? []) as Array<{
      contact_id: string | null
      status: string
      run_at: string
    }>) {
      if (!row.contact_id) continue
      // A row left `running` by a crashed cron call would otherwise
      // hold the contact forever.
      if (row.status === 'running' && Date.parse(row.run_at) < staleBefore) continue
      pendingContacts.add(row.contact_id)
    }
    for (const row of (broadcasts.data ?? []) as Array<{ contact_id: string; sent_at: string }>) {
      keepLatest(lastReminderByContact, row.contact_id, row.sent_at)
    }
  }

  const lastFollowUpByConversation = new Map<string, string>()
  const lastReminderByConversation = new Map<string, string>()
  const mediaConversations = new Set<string>()

  for (const ids of chunks(conversationIds)) {
    const [templates, media] = await Promise.all([
      db
        .from('messages')
        .select('conversation_id, template_name, created_at')
        .in('conversation_id', ids)
        .in('template_name', templateNames),
      db
        .from('messages')
        .select('conversation_id')
        .in('conversation_id', ids)
        .eq('sender_type', 'customer')
        .in('content_type', ['image', 'document']),
    ])
    if (templates.error) throw new Error(`messages: ${templates.error.message}`)
    if (media.error) throw new Error(`messages: ${media.error.message}`)

    for (const row of (templates.data ?? []) as Array<{
      conversation_id: string
      template_name: string
      created_at: string
    }>) {
      if (followUps.has(row.template_name)) {
        keepLatest(lastFollowUpByConversation, row.conversation_id, row.created_at)
      }
      if (row.template_name === reminderName) {
        keepLatest(lastReminderByConversation, row.conversation_id, row.created_at)
      }
    }
    for (const row of (media.data ?? []) as Array<{ conversation_id: string }>) {
      mediaConversations.add(row.conversation_id)
    }
  }

  const pipelineIds = [...new Set(deals.map((d) => d.pipeline_id))]
  const stages: RawStage[] = []
  if (pipelineIds.length > 0) {
    const { data, error } = await db
      .from('pipeline_stages')
      .select('id, pipeline_id, name, position, auto_close')
      .in('pipeline_id', pipelineIds)
    if (error) throw new Error(`pipeline_stages: ${error.message}`)
    stages.push(...((data ?? []) as RawStage[]))
  }

  return buildSnapshots({
    conversations,
    tagsByContact,
    deals,
    stages,
    pendingContacts,
    lastFollowUpByConversation,
    lastReminderByConversation,
    lastReminderByContact,
    mediaConversations,
    exemptTagName: cfg.exemptTagName,
  })
}

/** account id → user id the WhatsApp number was connected by (audit owner for sends). */
export async function loadSenders(db: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await db.from('whatsapp_config').select('account_id, user_id')
  if (error) throw new Error(`whatsapp_config: ${error.message}`)
  return new Map(
    ((data ?? []) as Array<{ account_id: string; user_id: string }>).map((r) => [r.account_id, r.user_id]),
  )
}

/**
 * Conversations a reminder was already attempted for in the last 24h.
 * A failed send is not retried every half hour, and a sent one is not
 * sent twice if the message row lagged behind.
 */
export async function loadRecentReminders(db: SupabaseClient, now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await db
    .from('lifecycle_actions')
    .select('conversation_id')
    .eq('action', 'remind')
    .in('outcome', ['done', 'failed'])
    .gte('created_at', since)
  if (error) throw new Error(`lifecycle_actions: ${error.message}`)
  return new Set(((data ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))
}
