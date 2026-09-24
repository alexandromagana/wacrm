import { describe, expect, it } from 'vitest'
import { buildSnapshots, type SnapshotInputs } from './load'

function inputs(overrides: Partial<SnapshotInputs> = {}): SnapshotInputs {
  return {
    conversations: [
      {
        id: 'conv-1',
        account_id: 'acct-1',
        contact_id: 'contact-1',
        status: 'open',
        assigned_agent_id: null,
        last_customer_message_at: '2026-09-10T00:00:00Z',
        created_at: '2026-09-01T00:00:00Z',
        close_suggested_at: null,
        close_suggestion_dismissed_at: null,
        contact: { name: 'Ana', phone: '+5215512345678' },
      },
    ],
    tagsByContact: new Map(),
    deals: [],
    stages: [
      { id: 'stage-new', pipeline_id: 'p', name: 'New Lead', position: 0, auto_close: true },
      { id: 'stage-quote', pipeline_id: 'p', name: 'Proposal Sent', position: 2, auto_close: true },
      { id: 'stage-visit', pipeline_id: 'p', name: 'Technical Visit', position: 3, auto_close: false },
    ],
    pendingContacts: new Set(),
    lastFollowUpByConversation: new Map(),
    lastReminderByConversation: new Map(),
    lastReminderByContact: new Map(),
    mediaConversations: new Set(),
    exemptTagName: 'No cerrar',
    ...overrides,
  }
}

const deal = (id: string, stage_id: string, created_at: string, status: 'open' | 'won' = 'open') => ({
  id,
  contact_id: 'contact-1',
  pipeline_id: 'p',
  stage_id,
  status,
  quoted_at: null,
  quote_url: null,
  created_at,
})

describe('buildSnapshots', () => {
  it('uses the newest open deal and reads its stage flags', () => {
    const [snap] = buildSnapshots(
      inputs({
        deals: [
          deal('old', 'stage-new', '2026-08-01T00:00:00Z'),
          deal('new', 'stage-visit', '2026-09-01T00:00:00Z'),
        ],
      }),
    )
    expect(snap.deal).toMatchObject({ id: 'new', stageName: 'Technical Visit', autoClose: false, isFirstStage: false })
    expect(snap.hasWonDeal).toBe(false)
  })

  it('marks the first stage by position', () => {
    const [snap] = buildSnapshots(inputs({ deals: [deal('d', 'stage-new', '2026-09-01T00:00:00Z')] }))
    expect(snap.deal?.isFirstStage).toBe(true)
  })

  it('treats an unknown stage as off-limits', () => {
    const [snap] = buildSnapshots(inputs({ deals: [deal('d', 'stage-gone', '2026-09-01T00:00:00Z')] }))
    expect(snap.deal?.autoClose).toBe(false)
  })

  it('notices a won deal', () => {
    const [snap] = buildSnapshots(inputs({ deals: [deal('w', 'stage-visit', '2026-09-01T00:00:00Z', 'won')] }))
    expect(snap.hasWonDeal).toBe(true)
    expect(snap.deal).toBeNull()
  })

  it('matches the exemption tag case-insensitively', () => {
    const [snap] = buildSnapshots(inputs({ tagsByContact: new Map([['contact-1', ['Hot lead', ' no CERRAR ']]]) }))
    expect(snap.exempt).toBe(true)
  })

  it('takes the later of a chat reminder and a broadcast one', () => {
    const [snap] = buildSnapshots(
      inputs({
        lastReminderByConversation: new Map([['conv-1', '2026-09-12T00:00:00Z']]),
        lastReminderByContact: new Map([['contact-1', '2026-09-15T00:00:00Z']]),
      }),
    )
    expect(snap.lastReminderAt).toBe('2026-09-15T00:00:00Z')
  })
})
