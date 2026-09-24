import { describe, expect, it } from 'vitest'
import type { Deal, PipelineStage } from '@/types'
import {
  computeMonthStats,
  isAliveDuring,
  isCarriedOver,
  isMonthKey,
  monthKeyOf,
  monthRange,
  monthsBetween,
  shiftMonth,
  stageProbability,
  statusAsOfMonthEnd,
} from './month'

const stages: PipelineStage[] = [
  { id: 's0', pipeline_id: 'p', name: 'New Lead', position: 0, color: '', created_at: '' },
  { id: 's1', pipeline_id: 'p', name: 'Proposal Sent', position: 1, color: '', created_at: '' },
  { id: 's2', pipeline_id: 'p', name: 'Technical Visit', position: 2, color: '', created_at: '' },
  { id: 's3', pipeline_id: 'p', name: 'Signed', position: 3, color: '', created_at: '', is_won: true },
]

function deal(overrides: Partial<Deal>): Deal {
  return {
    id: 'd',
    user_id: 'u',
    pipeline_id: 'p',
    stage_id: 's0',
    contact_id: 'c',
    title: 'Deal',
    value: 100,
    status: 'open',
    created_at: '2026-09-10T12:00:00Z',
    ...overrides,
  }
}

const september = monthRange('2026-09')

describe('month keys', () => {
  it('validates the YYYY-MM shape', () => {
    expect(isMonthKey('2026-09')).toBe(true)
    expect(isMonthKey('2026-13')).toBe(false)
    expect(isMonthKey('2026-9')).toBe(false)
    expect(isMonthKey(null)).toBe(false)
  })

  it('shifts across year boundaries', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-09', 0)).toBe('2026-09')
  })

  it('lists months newest first, inclusive', () => {
    expect(monthsBetween('2026-08', '2026-10')).toEqual(['2026-10', '2026-09', '2026-08'])
    expect(monthsBetween('2026-11', '2026-10')).toEqual([])
  })

  it('reads the month in Mexico City time, not UTC', () => {
    // 03:00 UTC on Oct 1 is still Sep 30 at 21:00 in Mexico City.
    expect(monthKeyOf(new Date('2026-10-01T03:00:00Z'))).toBe('2026-09')
    expect(monthKeyOf(new Date('2026-10-01T06:00:00Z'))).toBe('2026-10')
  })
})

describe('monthRange', () => {
  it('cuts the month at local midnight in Mexico City (UTC-6)', () => {
    expect(september.startIso).toBe('2026-09-01T06:00:00.000Z')
    expect(september.endIso).toBe('2026-10-01T06:00:00.000Z')
  })

  it('handles December into January', () => {
    const december = monthRange('2026-12')
    expect(december.startIso).toBe('2026-12-01T06:00:00.000Z')
    expect(december.endIso).toBe('2027-01-01T06:00:00.000Z')
  })

  it('follows a DST zone when asked', () => {
    // New York is UTC-4 in September, UTC-4 on Oct 1 too.
    const ny = monthRange('2026-09', 'America/New_York')
    expect(ny.startIso).toBe('2026-09-01T04:00:00.000Z')
    const nov = monthRange('2026-11', 'America/New_York')
    // Nov 1 2026 00:00 is still EDT (DST ends at 02:00 that day).
    expect(nov.startIso).toBe('2026-11-01T04:00:00.000Z')
    expect(nov.endIso).toBe('2026-12-01T05:00:00.000Z')
  })
})

describe('which deals a month shows', () => {
  it('shows deals created this month', () => {
    expect(isAliveDuring(deal({}), september)).toBe(true)
  })

  it('hides deals created after the month', () => {
    expect(isAliveDuring(deal({ created_at: '2026-10-02T00:00:00Z' }), september)).toBe(false)
  })

  it('carries over open deals from earlier months', () => {
    const old = deal({ created_at: '2026-08-05T00:00:00Z' })
    expect(isAliveDuring(old, september)).toBe(true)
    expect(isCarriedOver(old, september)).toBe(true)
    expect(isCarriedOver(deal({}), september)).toBe(false)
  })

  it('shows deals lost this month but not ones lost before it', () => {
    const lostNow = deal({ created_at: '2026-08-05T00:00:00Z', status: 'lost', closed_at: '2026-09-03T00:00:00Z' })
    const lostBefore = deal({ created_at: '2026-08-05T00:00:00Z', status: 'lost', closed_at: '2026-08-20T00:00:00Z' })
    expect(isAliveDuring(lostNow, september)).toBe(true)
    expect(isAliveDuring(lostBefore, september)).toBe(false)
  })

  it('treats a deal closed after the month as open back then', () => {
    const wonLater = deal({ status: 'won', closed_at: '2026-10-15T00:00:00Z' })
    expect(statusAsOfMonthEnd(wonLater, september)).toBe('open')
    expect(statusAsOfMonthEnd(wonLater, monthRange('2026-10'))).toBe('won')
  })
})

describe('stageProbability', () => {
  it('rises from 10% and gives the won stage 100%', () => {
    expect(stageProbability(stages[0], stages)).toBeCloseTo(0.1)
    expect(stageProbability(stages[2], stages)).toBeCloseTo(0.9)
    expect(stageProbability(stages[3], stages)).toBe(1)
  })
})

describe('computeMonthStats', () => {
  it('counts new, quoted, won, lost and open for the month', () => {
    const stats = computeMonthStats(
      [
        deal({ id: 'new', value: 100 }),
        deal({ id: 'quoted', stage_id: 's1', value: 200, quoted_at: '2026-09-12T00:00:00Z' }),
        deal({ id: 'carried', stage_id: 's2', value: 300, created_at: '2026-08-01T12:00:00Z', quoted_at: '2026-08-10T00:00:00Z' }),
        deal({ id: 'won', stage_id: 's3', value: 400, status: 'won', closed_at: '2026-09-20T00:00:00Z' }),
        deal({ id: 'lost', value: 50, status: 'lost', lost_reason: 'auto_sin_recibo', closed_at: '2026-09-21T00:00:00Z' }),
        deal({ id: 'lost2', value: 50, status: 'lost', closed_at: '2026-09-22T00:00:00Z' }),
        deal({ id: 'lost-aug', created_at: '2026-08-01T12:00:00Z', status: 'lost', closed_at: '2026-08-25T00:00:00Z' }),
        deal({ id: 'october', created_at: '2026-10-05T00:00:00Z' }),
      ],
      stages,
      september,
    )
    expect(stats.newCount).toBe(5)
    expect(stats.quotedCount).toBe(1)
    expect(stats.wonCount).toBe(1)
    expect(stats.wonValue).toBe(400)
    expect(stats.lostCount).toBe(2)
    expect(stats.lostByReason).toEqual({ auto_sin_recibo: 1, '': 1 })
    expect(stats.openCount).toBe(3)
    expect(stats.openValue).toBe(600)
    expect(stats.weightedValue).toBeCloseTo(100 * 0.1 + 200 * 0.5 + 300 * 0.9)
  })

  it('counts a deal won in a later month as open in this one', () => {
    const stats = computeMonthStats(
      [deal({ status: 'won', stage_id: 's3', closed_at: '2026-10-15T00:00:00Z' })],
      stages,
      september,
    )
    expect(stats.wonCount).toBe(0)
    expect(stats.openCount).toBe(1)
  })
})
