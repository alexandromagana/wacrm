import { describe, expect, it } from 'vitest'
import { LIFECYCLE_CONFIG } from './config'
import { decideLifecycleAction, type LifecycleSnapshot } from './rules'

const NOW = new Date('2026-09-23T17:00:00Z')

/** ISO timestamp `days` before NOW. */
function ago(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

const NEW_LEAD_DEAL = {
  id: 'deal-1',
  stageId: 'stage-new',
  stageName: 'New Lead',
  autoClose: true,
  isFirstStage: true,
  quotedAt: null,
  quoteUrl: null,
}

const QUOTED_DEAL = {
  ...NEW_LEAD_DEAL,
  stageId: 'stage-proposal',
  stageName: 'Proposal Sent',
  isFirstStage: false,
  quoteUrl: 'https://example.test/q.pdf',
}

function snap(overrides: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot {
  return {
    accountId: 'acct-1',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    contactName: 'Ana López',
    contactPhone: '+5215512345678',
    status: 'open',
    assignedAgentId: null,
    lastCustomerMessageAt: ago(1),
    conversationCreatedAt: ago(30),
    closeSuggestedAt: null,
    closeSuggestionDismissedAt: null,
    exempt: false,
    deal: NEW_LEAD_DEAL,
    hasWonDeal: false,
    hasPendingAutomation: false,
    lastFollowUpAt: null,
    lastReminderAt: null,
    customerSentMedia: false,
    ...overrides,
  }
}

function decide(s: LifecycleSnapshot, inBusinessHours = true) {
  return decideLifecycleAction(s, NOW, LIFECYCLE_CONFIG, { inBusinessHours })
}

describe('leaves alone', () => {
  it.each([
    ['a closed chat', { status: 'closed' as const, lastCustomerMessageAt: ago(60) }, 'closed'],
    ['an exempt contact', { exempt: true, lastCustomerMessageAt: ago(60) }, 'exempt'],
    ['a contact with a won deal', { hasWonDeal: true, lastCustomerMessageAt: ago(60) }, 'won'],
    [
      'a deal past the proposal stage',
      { deal: { ...QUOTED_DEAL, autoClose: false }, lastCustomerMessageAt: ago(60) },
      'protected_stage',
    ],
    [
      'a contact whose follow-ups are still scheduled',
      { deal: QUOTED_DEAL, hasPendingAutomation: true, lastCustomerMessageAt: ago(60) },
      'automation_pending',
    ],
  ])('%s', (_label, overrides, reason) => {
    expect(decide(snap(overrides))).toMatchObject({ action: 'none', reason })
  })
})

describe('quoted prospects', () => {
  it('waits 8 days of silence after the quote', () => {
    const s = snap({ deal: { ...QUOTED_DEAL, quotedAt: ago(7) }, lastCustomerMessageAt: ago(7) })
    expect(decide(s).action).toBe('none')
  })

  it('closes 3 days after the 2nd follow-up with no reply', () => {
    // Quote on day 0, follow-ups on day 2 and day 5, today is day 8.
    const s = snap({
      deal: { ...QUOTED_DEAL, quotedAt: ago(8) },
      lastCustomerMessageAt: ago(8),
      lastFollowUpAt: ago(3),
    })
    expect(decide(s)).toMatchObject({ action: 'close', reason: 'auto_sin_respuesta_seguimientos' })
  })

  it('waits when the last follow-up went out less than 3 days ago', () => {
    const s = snap({
      deal: { ...QUOTED_DEAL, quotedAt: ago(10) },
      lastCustomerMessageAt: ago(10),
      lastFollowUpAt: ago(2),
    })
    expect(decide(s).action).toBe('none')
  })

  it('restarts the clock when the customer replies after the follow-up', () => {
    const s = snap({
      deal: { ...QUOTED_DEAL, quotedAt: ago(12) },
      lastFollowUpAt: ago(7),
      lastCustomerMessageAt: ago(4),
    })
    expect(decide(s).action).toBe('none')
  })

  it('closes a legacy quote that never got follow-ups once silent 8 days', () => {
    const s = snap({ deal: { ...QUOTED_DEAL, quotedAt: ago(40) }, lastCustomerMessageAt: ago(20) })
    expect(decide(s)).toMatchObject({ action: 'close', reason: 'auto_sin_respuesta_seguimientos', silentDays: 20 })
  })

  it('counts a follow-up template as proof of a quote', () => {
    const s = snap({ deal: NEW_LEAD_DEAL, lastCustomerMessageAt: ago(9), lastFollowUpAt: ago(4) })
    expect(decide(s).reason).toBe('auto_sin_respuesta_seguimientos')
  })
})

describe('leads that never sent their bill', () => {
  it('does nothing for 2 days', () => {
    expect(decide(snap({ lastCustomerMessageAt: ago(2) })).action).toBe('none')
  })

  it('sends the reminder after 3 days, in business hours', () => {
    expect(decide(snap({ lastCustomerMessageAt: ago(3) }))).toMatchObject({
      action: 'remind',
      reason: 'auto_sin_recibo',
    })
  })

  it('holds the reminder outside business hours', () => {
    expect(decide(snap({ lastCustomerMessageAt: ago(3) }), false)).toMatchObject({
      action: 'none',
      reason: 'outside_hours',
    })
  })

  it('reminds a contact with no deal the same way', () => {
    expect(decide(snap({ deal: null, lastCustomerMessageAt: ago(5) })).action).toBe('remind')
  })

  it('waits 4 days after the reminder', () => {
    const s = snap({ lastCustomerMessageAt: ago(6), lastReminderAt: ago(3) })
    expect(decide(s).action).toBe('none')
  })

  it('closes 4 days after the reminder', () => {
    const s = snap({ lastCustomerMessageAt: ago(7), lastReminderAt: ago(4) })
    expect(decide(s)).toMatchObject({ action: 'close', reason: 'auto_sin_recibo' })
  })

  it('reminds again after the customer replied to an earlier reminder', () => {
    // Reminder went out 10 days ago, they answered 5 days ago, then went
    // quiet: a new silence, a new reminder.
    const s = snap({ lastReminderAt: ago(10), lastCustomerMessageAt: ago(5) })
    expect(decide(s).action).toBe('remind')
  })

  it('closes without a reminder after 45 days of silence', () => {
    expect(decide(snap({ lastCustomerMessageAt: ago(45) }))).toMatchObject({
      action: 'close',
      reason: 'auto_sin_recibo',
    })
  })

  it('only suggests when they did send a file (the bill may be sitting there)', () => {
    const s = snap({ lastCustomerMessageAt: ago(8), customerSentMedia: true })
    expect(decide(s)).toMatchObject({ action: 'suggest', reason: 'auto_sin_respuesta' })
  })

  it('only suggests a deal stuck in a middle stage without a quote', () => {
    const s = snap({
      deal: { ...NEW_LEAD_DEAL, isFirstStage: false, stageName: 'Qualified' },
      lastCustomerMessageAt: ago(8),
    })
    expect(decide(s).action).toBe('suggest')
  })
})

describe('contacts that never wrote', () => {
  it('closes 4 days after the reminder template reached them', () => {
    const s = snap({ deal: null, lastCustomerMessageAt: null, lastReminderAt: ago(4) })
    expect(decide(s)).toMatchObject({ action: 'close', reason: 'auto_sin_contacto' })
  })

  it('leaves them alone if nothing was ever sent', () => {
    const s = snap({ deal: null, lastCustomerMessageAt: null })
    expect(decide(s)).toMatchObject({ action: 'none', reason: 'never_wrote' })
  })
})

describe('chats a person owns', () => {
  const owned = { assignedAgentId: 'agent-1' }

  it('suggests instead of closing', () => {
    const s = snap({ ...owned, deal: { ...QUOTED_DEAL, quotedAt: ago(20) }, lastCustomerMessageAt: ago(20) })
    expect(decide(s)).toMatchObject({ action: 'suggest', reason: 'auto_sin_respuesta_seguimientos' })
  })

  it('never sends the reminder, and suggests after 7 days instead', () => {
    expect(decide(snap({ ...owned, lastCustomerMessageAt: ago(4) })).action).toBe('none')
    expect(decide(snap({ ...owned, lastCustomerMessageAt: ago(7) }))).toMatchObject({
      action: 'suggest',
      reason: 'auto_sin_recibo',
    })
  })

  it('suggests only once', () => {
    const s = snap({ ...owned, lastCustomerMessageAt: ago(9), closeSuggestedAt: ago(1) })
    expect(decide(s)).toMatchObject({ action: 'none', reason: 'already_suggested' })
  })

  it('respects a dismissal made after the customer last wrote', () => {
    const s = snap({ ...owned, lastCustomerMessageAt: ago(9), closeSuggestionDismissedAt: ago(2) })
    expect(decide(s)).toMatchObject({ action: 'none', reason: 'suggestion_dismissed' })
  })

  it('suggests again when the customer wrote after the dismissal', () => {
    const s = snap({ ...owned, lastCustomerMessageAt: ago(9), closeSuggestionDismissedAt: ago(12) })
    expect(decide(s).action).toBe('suggest')
  })
})
