import { describe, it, expect } from 'vitest'
import {
  ANNUAL_INFLATION,
  BIMESTERS_PER_YEAR,
  FIXED_CHARGE_BIMONTHLY_MXN,
  HORIZON_YEARS,
  bimonthlyGenerationKwh,
  buildFinancials,
  cumulativeFactor,
} from './finance'
import { SOLAR_TIERS, lookupSolarTier } from './pricing'

/** Osvaldo Coyac's receipt — the case the whole model was derived from. */
const OSVALDO = {
  /** Fac. del Periodo 9,814.27 + DAP 423.03. NOT the 10,237.85 total. */
  costoBimestralMxn: 10_237.3,
  /** Average of 2944, 2177, 1487, 1447, 1966, 2788. */
  kwh: 2135,
}
const TIER_14 = SOLAR_TIERS.find((t) => t.panels === 14)!

describe('cumulativeFactor', () => {
  it('matches the closed form at the horizon we print', () => {
    expect(cumulativeFactor(HORIZON_YEARS, ANNUAL_INFLATION)).toBeCloseTo(
      38.9499,
      4,
    )
  })

  it('is NOT a multiplication — this is the whole point of the module', () => {
    // If someone "simplifies" the 25-year total to firstYear * 25, this
    // is the test that fails. On Osvaldo's bill the gap is $856,853.
    const factor = cumulativeFactor(HORIZON_YEARS, ANNUAL_INFLATION)
    expect(factor).toBeGreaterThan(HORIZON_YEARS)
    const annual = OSVALDO.costoBimestralMxn * BIMESTERS_PER_YEAR
    expect(Math.round(annual * factor - annual * HORIZON_YEARS)).toBe(856_853)
  })

  it('degenerates to plain multiplication at zero inflation', () => {
    expect(cumulativeFactor(25, 0)).toBe(25)
  })

  it('is 1 for a single year, whatever the inflation', () => {
    expect(cumulativeFactor(1, 0.035)).toBeCloseTo(1, 10)
    expect(cumulativeFactor(1, 0.2)).toBeCloseTo(1, 10)
  })

  it('returns 0 for a non-positive or non-finite horizon', () => {
    expect(cumulativeFactor(0, 0.035)).toBe(0)
    expect(cumulativeFactor(-5, 0.035)).toBe(0)
    expect(cumulativeFactor(NaN, 0.035)).toBe(0)
  })
})

describe('bimonthlyGenerationKwh', () => {
  it('gives 159.375 kWh per panel', () => {
    // 625 W x 5 h x 0.85 / 1000 x 60 d
    expect(bimonthlyGenerationKwh(1)).toBe(159.375)
  })

  it('scales linearly', () => {
    expect(bimonthlyGenerationKwh(14)).toBeCloseTo(2231.25, 6)
    expect(bimonthlyGenerationKwh(0)).toBe(0)
  })

  it('covers every tier without over-promising at the ceiling', () => {
    // The price table and this formula have to agree, or the proposal
    // claims a system that cannot carry the consumption it was sold
    // for. Coverage rises monotonically across the table — with one
    // exception, and it is the sheet's, not a rounding artifact: the
    // 18-panel band runs 336 kWh wide where every other band runs 320,
    // so its ceiling sits 16 kWh past where the cadence would put it
    // and its coverage lands under the 16-panel band's. Pinned to that
    // one panel count rather than waived, so a SECOND dip still fails.
    let previous = 0
    for (const tier of SOLAR_TIERS) {
      const coverage = bimonthlyGenerationKwh(tier.panels) / tier.maxKwh
      expect(coverage).toBeGreaterThan(0.9)
      expect(coverage).toBeLessThan(1)
      if (tier.panels !== 18) expect(coverage).toBeGreaterThan(previous)
      previous = coverage
    }
  })
})

describe('buildFinancials — Osvaldo, the reference case', () => {
  const tier = lookupSolarTier(OSVALDO.kwh)!
  const f = buildFinancials({
    costoBimestralMxn: OSVALDO.costoBimestralMxn,
    tier,
  })!

  it('lands on the 14-panel tier', () => {
    expect(tier).toEqual(TIER_14)
    expect(tier.priceMxn).toBe(127_000)
  })

  it('produces the six card amounts', () => {
    expect(Math.round(f.sinPanelesBimestre)).toBe(10_237)
    expect(Math.round(f.sinPaneles12Meses)).toBe(61_424)
    expect(Math.round(f.sinPaneles25Anios)).toBe(2_392_448)
    expect(f.conPanelesBimestre).toBe(65)
    expect(f.conPaneles12Meses).toBe(390)
    expect(Math.round(f.conPaneles25Anios)).toBe(142_190)
  })

  it('produces the savings, payback and generation', () => {
    expect(Math.round(f.ahorro25Anios)).toBe(2_250_258)
    expect(f.paybackAnios).toBe(2)
    expect(f.paybackMeses).toBe(1)
    expect(f.kwhGeneradosBimestre).toBeCloseTo(2231.25, 6)
  })

  it('keeps the cards internally consistent', () => {
    expect(f.sinPaneles12Meses).toBeCloseTo(
      f.sinPanelesBimestre * BIMESTERS_PER_YEAR,
      6,
    )
    expect(f.ahorro25Anios).toBeCloseTo(
      f.sinPaneles25Anios - f.conPaneles25Anios,
      6,
    )
    // The system price is paid once, so it must be inside the 25-year
    // "with panels" figure and not amortised into it twice.
    expect(f.conPaneles25Anios).toBeGreaterThan(tier.priceMxn)
  })
})

describe('buildFinancials — guards', () => {
  const tier = TIER_14

  it('refuses to project without a readable bill', () => {
    expect(buildFinancials({ costoBimestralMxn: null, tier })).toBeNull()
    expect(buildFinancials({ costoBimestralMxn: NaN, tier })).toBeNull()
  })

  it('refuses when the bill is at or under the fixed charge', () => {
    // Nothing to save, and the payback would be infinite.
    expect(
      buildFinancials({ costoBimestralMxn: FIXED_CHARGE_BIMONTHLY_MXN, tier }),
    ).toBeNull()
    expect(buildFinancials({ costoBimestralMxn: 10, tier })).toBeNull()
  })

  it('refuses when the system would not pay for itself in 25 years', () => {
    // $200/bimester against a $140,000 system: $810/yr of savings.
    const big = SOLAR_TIERS[SOLAR_TIERS.length - 1]
    expect(buildFinancials({ costoBimestralMxn: 200, tier: big })).toBeNull()
  })

  it('never reports twelve months instead of another year', () => {
    // Sweep bills across the table; the months field is a remainder.
    for (const t of SOLAR_TIERS) {
      for (let bill = 1_000; bill <= 30_000; bill += 137) {
        const f = buildFinancials({ costoBimestralMxn: bill, tier: t })
        if (!f) continue
        expect(f.paybackMeses).toBeGreaterThanOrEqual(0)
        expect(f.paybackMeses).toBeLessThan(12)
        expect(f.paybackAnios).toBeGreaterThanOrEqual(0)
        expect(f.paybackAnios).toBeLessThanOrEqual(HORIZON_YEARS)
      }
    }
  })

  it('pays back faster the bigger the bill', () => {
    const months = (bill: number) => {
      const f = buildFinancials({ costoBimestralMxn: bill, tier })!
      return f.paybackAnios * 12 + f.paybackMeses
    }
    expect(months(20_000)).toBeLessThan(months(10_000))
    expect(months(10_000)).toBeLessThan(months(5_000))
  })
})
