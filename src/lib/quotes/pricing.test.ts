import { describe, it, expect } from 'vitest'
import {
  SOLAR_TIERS,
  MAX_QUOTABLE_KWH,
  WATTS_PER_PANEL,
  lookupSolarTier,
  resolveQuote,
  findAnomalousPeriod,
  findAnomalousHighPeriod,
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
    expect(lookupSolarTier(MAX_QUOTABLE_KWH)?.panels).toBe(40)
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
    const past = MAX_QUOTABLE_KWH + 1
    expect(resolveQuote(past, 6)).toEqual({ kind: 'above_table', kwh: past })
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

  it('lets a low-baseline house through its own 5:1 winter dip', () => {
    // The bill that exposed the old rule. 328 kWh is the DIC-FEB
    // bimester of a house whose load is nearly all air conditioning —
    // the previous January on the same bill read 312, so it is the
    // season, not a vacancy. Against the mean it looked like an empty
    // house and the quote was refused; against the median it prices.
    const res = resolveQuote(926, 6, {
      includesCurrentPeriod: true,
      periods: [1611, 1220, 683, 328, 655, 1060],
    })
    expect(res.kind).toBe('ok')
  })

  it('holds the document when one bimester towers over the rest', () => {
    // The mirror of the vacancy case, and the one that costs the
    // customer rather than the company: a single inflated figure drags
    // the average up a tier and sells a system bigger than the roof
    // needs. The tier still resolves so the bot can ballpark if pressed.
    const res = resolveQuote(1_263, 6, {
      includesCurrentPeriod: true,
      periods: [900, 850, 800, 950, 5200, 880],
    })
    expect(res.kind).toBe('needs_review')
    if (res.kind !== 'needs_review') return
    expect(res.reason).toBe('anomalous_history_high')
    expect(res.outlierKwh).toBe(5_200)
    expect(res.tier.panels).toBe(8)
  })

  it('reports an empty house ahead of an inflated bimester', () => {
    // Both fire on this window. The vacancy question is the one the
    // customer can actually answer with a yes or a no, so it wins.
    const res = resolveQuote(1_100, 6, {
      includesCurrentPeriod: true,
      periods: [50, 1_000, 1_000, 1_000, 1_000, 5_000],
    })
    expect(res.kind).toBe('needs_review')
    if (res.kind !== 'needs_review') return
    expect(res.reason).toBe('anomalous_history')
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

  it('needs a 5.7:1 spread before calling it on two periods', () => {
    // At n=2 the median IS the mean, so the outlier drags the very
    // number it is compared against and the rule is hard to trip by
    // design.
    expect(findAnomalousPeriod([2545, 216])).toBe(216)
    expect(findAnomalousPeriod([1000, 500])).toBeNull()
  })

  it('still catches a house left empty for two bimesters running', () => {
    // The reason the rule stays keyed to the single lowest value: two
    // adjacent lows are what a real vacancy looks like, and a
    // lowest-vs-next-lowest test would read them as a stable baseline.
    expect(findAnomalousPeriod([1200, 1100, 80, 90, 1300, 1250])).toBe(80)
  })

  it('ignores the winter of a low-baseline house', () => {
    expect(
      findAnomalousPeriod([1611, 1220, 683, 328, 655, 1060]),
    ).toBeNull()
  })

  it('says nothing about a single period, or about zeroes', () => {
    expect(findAnomalousPeriod([1200])).toBeNull()
    expect(findAnomalousPeriod([])).toBeNull()
    expect(findAnomalousPeriod([0, 0])).toBeNull()
  })
})

describe('findAnomalousHighPeriod', () => {
  it('flags a bimester that towers over the rest', () => {
    // The shape of a misread: five ordinary bimesters and one that could
    // only be the accumulated meter reading wearing a period's clothes.
    expect(findAnomalousHighPeriod([900, 850, 800, 950, 5200, 880])).toBe(5200)
  })

  it('leaves every legitimate bill on file alone', () => {
    // The regression that matters most. Each of these is a real window
    // that must keep pricing without a human — the low-baseline house
    // that broke the old floor rule peaks at 1.85x its median, the
    // ordinary Cancún swing at 1.42x, and the vacancy fixture, which is
    // the highest-peaking real window we have, at 2.32x. A ceiling that
    // catches any of them has been set too low.
    expect(findAnomalousHighPeriod([1611, 1220, 683, 328, 655, 1060])).toBeNull()
    expect(
      findAnomalousHighPeriod([2944, 2177, 1487, 1447, 1966, 2788]),
    ).toBeNull()
    expect(findAnomalousHighPeriod([2545, 1126, 879, 1067, 1485, 216])).toBeNull()
  })

  it('cannot fire on two periods, however far apart they are', () => {
    // The max of two positives is always under twice their mean, and at
    // n=2 the median IS the mean — so the ceiling is unreachable here by
    // arithmetic, not by choice. Documented so a future reader does not
    // read it as a bug.
    expect(findAnomalousHighPeriod([100, 100_000])).toBeNull()
  })

  it('says nothing about a single period, or about zeroes', () => {
    expect(findAnomalousHighPeriod([1200])).toBeNull()
    expect(findAnomalousHighPeriod([])).toBeNull()
    expect(findAnomalousHighPeriod([0, 0])).toBeNull()
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
