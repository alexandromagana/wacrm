import { describe, expect, it } from 'vitest'
import { isBusinessHours } from './business-hours'
import { LIFECYCLE_CONFIG } from './config'

const hours = LIFECYCLE_CONFIG.businessHours

describe('isBusinessHours (Mexico City, 9–19, Mon–Sat)', () => {
  it('is open mid-morning on a weekday', () => {
    // Wed 2026-09-23 10:00 CDMX = 16:00 UTC
    expect(isBusinessHours(new Date('2026-09-23T16:00:00Z'), hours)).toBe(true)
  })

  it('opens at 9 and closes at 19 local time', () => {
    expect(isBusinessHours(new Date('2026-09-23T14:59:00Z'), hours)).toBe(false) // 08:59
    expect(isBusinessHours(new Date('2026-09-23T15:00:00Z'), hours)).toBe(true) // 09:00
    expect(isBusinessHours(new Date('2026-09-24T00:59:00Z'), hours)).toBe(true) // 18:59
    expect(isBusinessHours(new Date('2026-09-24T01:00:00Z'), hours)).toBe(false) // 19:00
  })

  it('uses the local day, not the UTC one', () => {
    // Sat 2026-09-26 18:30 CDMX is already Sunday 00:30 UTC.
    expect(isBusinessHours(new Date('2026-09-27T00:30:00Z'), hours)).toBe(true)
  })

  it('stays closed on Sunday', () => {
    expect(isBusinessHours(new Date('2026-09-27T17:00:00Z'), hours)).toBe(false)
  })
})
