import { describe, it, expect } from 'vitest'
import {
  SOLAR_TIERS,
  MAX_QUOTABLE_KWH,
  WATTS_PER_PANEL,
  lookupSolarTier,
  resolveQuote,
  findAnomalousPeriod,
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

  it('stays quotable when no evidence is supplied', () => {
    // The two-argument call is what answers "¿cuánto por 1,500 kWh?" in
    // chat, with no receipt behind it and nothing to review.
    expect(resolveQuote(1_450, 6).kind).toBe('ok')
  })

  it('holds the document when the current period never made the average', () => {
    const res = resolveQuote(955, 5, {
      includesCurrentPeriod: false,
      periods: [1126, 879, 1067, 1485, 216],
    })
    expect(res.kind).toBe('needs_review')
    if (res.kind !== 'needs_review') return
    expect(res.reason).toBe('missing_current_period')
    // The tier still resolves — the bot may ballpark, it just may not
    // put this on a PDF unattended.
    expect(res.tier.panels).toBe(6)
  })

  it('holds the document when the history hides an empty house', () => {
    // The real case: six periods averaging 1,220 kWh, one of them 216 —
    // the bimester the house sat unoccupied. The average prices cleanly
    // at 8 panels and is still the wrong question to answer silently.
    const res = resolveQuote(1_220, 6, {
      includesCurrentPeriod: true,
      periods: [2545, 1126, 879, 1067, 1485, 216],
    })
    expect(res.kind).toBe('needs_review')
    if (res.kind !== 'needs_review') return
    expect(res.reason).toBe('anomalous_history')
    expect(res.outlierKwh).toBe(216)
    expect(res.tier.panels).toBe(8)
  })

  it('reports a missing current period ahead of an outlier', () => {
    // Both are true here. The missing page is the one the bot can fix by
    // asking for a photo, so it must be the reason surfaced.
    const res = resolveQuote(800, 5, {
      includesCurrentPeriod: false,
      periods: [1400, 1300, 1200, 1000, 100],
    })
    expect(res.kind).toBe('needs_review')
    if (res.kind !== 'needs_review') return
    expect(res.reason).toBe('missing_current_period')
  })

  it('lets an ordinary Cancún summer/winter swing through', () => {
    // 2:1 between the hottest and coldest bimester is normal here and
    // must not be mistaken for a vacancy, or every quote needs a human.
    const res = resolveQuote(2_135, 6, {
      includesCurrentPeriod: true,
      periods: [2944, 2177, 1487, 1447, 1966, 2788],
    })
    expect(res.kind).toBe('ok')
  })
})

describe('findAnomalousPeriod', () => {
  it('flags the vacant bimester and returns it', () => {
    expect(findAnomalousPeriod([2545, 1126, 879, 1067, 1485, 216])).toBe(216)
  })

  it('ignores a merely seasonal dip', () => {
    expect(findAnomalousPeriod([2944, 2177, 1487, 1447, 1966, 2788])).toBeNull()
  })

  it('needs a 4:1 spread before calling it on two periods', () => {
    // At n=2 the outlier drags the mean it is compared against, so the
    // rule is deliberately hard to trip.
    expect(findAnomalousPeriod([2545, 216])).toBe(216)
    expect(findAnomalousPeriod([1000, 500])).toBeNull()
  })

  it('says nothing about a single period, or about zeroes', () => {
    expect(findAnomalousPeriod([1200])).toBeNull()
    expect(findAnomalousPeriod([])).toBeNull()
    expect(findAnomalousPeriod([0, 0])).toBeNull()
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
