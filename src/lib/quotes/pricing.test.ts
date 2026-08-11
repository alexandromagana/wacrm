import { describe, it, expect } from 'vitest'
import {
  SOLAR_TIERS,
  MAX_QUOTABLE_KWH,
  WATTS_PER_PANEL,
  lookupSolarTier,
  resolveQuote,
  renderPricingTableForPrompt,
} from './pricing'

describe('SOLAR_TIERS — table invariants', () => {
  // These guard a future price edit: a fat-fingered bound that opens a
  // gap would otherwise surface as a customer getting no quote at all.
  it('has no gaps and no overlaps', () => {
    for (let i = 1; i < SOLAR_TIERS.length; i++) {
      expect(SOLAR_TIERS[i].minKwh).toBe(SOLAR_TIERS[i - 1].maxKwh + 1)
    }
  })

  it('starts at zero and ends at MAX_QUOTABLE_KWH', () => {
    expect(SOLAR_TIERS[0].minKwh).toBe(0)
    expect(SOLAR_TIERS[SOLAR_TIERS.length - 1].maxKwh).toBe(MAX_QUOTABLE_KWH)
  })

  it('increases monotonically in panels, kW and price', () => {
    for (let i = 1; i < SOLAR_TIERS.length; i++) {
      expect(SOLAR_TIERS[i].panels).toBeGreaterThan(SOLAR_TIERS[i - 1].panels)
      expect(SOLAR_TIERS[i].systemKw).toBeGreaterThan(SOLAR_TIERS[i - 1].systemKw)
      expect(SOLAR_TIERS[i].priceMxn).toBeGreaterThan(SOLAR_TIERS[i - 1].priceMxn)
    }
  })

  it('divides out to exactly WATTS_PER_PANEL in every tier', () => {
    // The proposal prints "625 W por panel" as a fact. If a new tier
    // ever breaks the ratio, that line becomes a lie — fail here first.
    for (const t of SOLAR_TIERS) {
      expect((t.systemKw * 1000) / t.panels).toBe(WATTS_PER_PANEL)
    }
  })
})

describe('lookupSolarTier', () => {
  it('is inclusive on both bounds of every tier', () => {
    for (const t of SOLAR_TIERS) {
      expect(lookupSolarTier(t.minKwh)).toBe(t)
      expect(lookupSolarTier(t.maxKwh)).toBe(t)
    }
  })

  it('places each documented boundary pair in adjacent tiers', () => {
    const boundaries = [704, 1_024, 1_344, 1_664, 1_984, 2_304]
    for (const b of boundaries) {
      const below = lookupSolarTier(b)
      const above = lookupSolarTier(b + 1)
      expect(below).not.toBeNull()
      expect(above).not.toBeNull()
      expect(above!.panels).toBe(below!.panels + 2)
    }
  })

  it('rounds rather than falling into the gap between tiers', () => {
    expect(lookupSolarTier(704.4)?.panels).toBe(4)
    expect(lookupSolarTier(704.6)?.panels).toBe(6)
  })

  it('returns the top tier at the cap and null just past it', () => {
    expect(lookupSolarTier(MAX_QUOTABLE_KWH)?.panels).toBe(16)
    expect(lookupSolarTier(MAX_QUOTABLE_KWH + 1)).toBeNull()
  })

  it('returns null for non-finite and negative input instead of throwing', () => {
    expect(lookupSolarTier(NaN)).toBeNull()
    expect(lookupSolarTier(Infinity)).toBeNull()
    expect(lookupSolarTier(-1)).toBeNull()
  })

  it('still resolves very low readings — the first tier starts at 0', () => {
    expect(lookupSolarTier(0)?.panels).toBe(4)
    expect(lookupSolarTier(120)?.panels).toBe(4)
  })
})

describe('resolveQuote', () => {
  it('quotes a normal reading with enough periods', () => {
    const res = resolveQuote(1_450, 6)
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.tier.panels).toBe(10)
    expect(res.tier.systemKw).toBe(6.25)
    expect(res.tier.priceMxn).toBe(95_000)
  })

  it('withholds the PDF when only one period was legible', () => {
    const res = resolveQuote(1_450, 1)
    expect(res.kind).toBe('low_confidence')
    // The tier still comes through — the bot quotes in text, it just
    // does not commit the number to a document.
    if (res.kind !== 'low_confidence') return
    expect(res.tier.panels).toBe(10)
    expect(res.periods).toBe(1)
  })

  it('escalates above the table', () => {
    expect(resolveQuote(2_625, 6)).toEqual({ kind: 'above_table', kwh: 2_625 })
  })

  it('reports an implausible reading as implausible, not above_table', () => {
    // 25,000 kWh is both past the table and past the sanity bound. The
    // reply for "that reading looks wrong" is not the reply for "your
    // project needs a custom design", so the order must not flip.
    expect(resolveQuote(25_000, 6).kind).toBe('implausible')
    expect(resolveQuote(10, 6).kind).toBe('implausible')
  })

  it('treats a missing or broken reading as unreadable', () => {
    expect(resolveQuote(null, 6)).toEqual({ kind: 'unreadable' })
    expect(resolveQuote(NaN, 6)).toEqual({ kind: 'unreadable' })
    expect(resolveQuote(Infinity, 6)).toEqual({ kind: 'unreadable' })
  })

  it('checks plausibility before period count', () => {
    // Otherwise a garbage reading from one page would be reported as
    // "almost quotable" instead of "unusable".
    expect(resolveQuote(30, 1).kind).toBe('implausible')
  })
})

describe('renderPricingTableForPrompt', () => {
  it('renders every tier plus the escalation row', () => {
    const table = renderPricingTableForPrompt()
    for (const t of SOLAR_TIERS) {
      expect(table).toContain(`| ${t.panels} |`)
      expect(table).toContain(`$${t.priceMxn.toLocaleString('es-MX')}`)
    }
    expect(table).toContain('Escala a Alejandro')
    expect(table.split('\n')).toHaveLength(SOLAR_TIERS.length + 3)
  })
})
