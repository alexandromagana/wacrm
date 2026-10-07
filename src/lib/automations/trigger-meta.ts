import type { AutomationTriggerType } from '@/types'

/**
 * A trigger is a category, not a state, so it carries a label only —
 * the list renders it as plain text rather than a coloured pill.
 */
export interface TriggerMeta {
  label: string
}

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: {
    label: 'New Message',
  },
  first_inbound_message: {
    label: 'First Message from Contact',
  },
  keyword_match: {
    label: 'Keyword Match',
  },
  new_contact_created: {
    label: 'New Contact',
  },
  conversation_assigned: {
    label: 'Conversation Assigned',
  },
  tag_added: {
    label: 'Tag Added',
  },
  tag_removed: {
    label: 'Tag Removed',
  },
  time_based: {
    label: 'Time-Based',
  },
  interactive_reply: {
    label: 'Button / List Reply',
  },
  deal_stage_changed: {
    label: 'Deal Stage Changed',
  },
  deal_won: {
    label: 'Deal Won',
  },
  deal_lost: {
    label: 'Deal Lost',
  },
}

export function triggerMeta(t: AutomationTriggerType | string): TriggerMeta {
  return (
    TRIGGER_META[t as AutomationTriggerType] ?? { label: t }
  )
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 2_592_000) return `${Math.floor(diffSec / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}
