import { describe, it, expect } from 'vitest'
import { validateTierTable, type TierInput } from './tier-validation'
import { SOLAR_TIERS } from './pricing'

const tier = (over: Partial<TierInput> = {}): TierInput => ({
  minKwh: 0,
  maxKwh: 704,
  panels: 4,
  systemKw: 2.5,
  priceMxn: 43_200,
  ...over,
})

describe('validateTierTable', () => {
  it('accepts the residential table the bot already ships', () => {
    expect(validateTierTable(SOLAR_TIERS)).toEqual([])
  })

  it('rejects an empty table', () => {
    expect(validateTierTable([])).toHaveLength(1)
  })

  it('catches a range that ends before it starts', () => {
    const errors = validateTierTable([tier({ minKwh: 900, maxKwh: 500 })])
    expect(errors.join(' ')).toContain('mayor o igual al mínimo')
  })

  it.each([
    ['panels', { panels: 0 }],
    ['systemKw', { systemKw: 0 }],
    ['priceMxn', { priceMxn: 0 }],
  ])('rejects a non-positive %s', (_label, over) => {
    expect(validateTierTable([tier(over)])).not.toEqual([])
  })

  it('rejects a negative minimum', () => {
    expect(validateTierTable([tier({ minKwh: -1 })])).not.toEqual([])
  })

  // The reason this module exists: overlapping rows don't throw at
  // lookup time, they just make the second row unreachable.
  it('catches overlapping ranges', () => {
    const errors = validateTierTable([
      tier({ minKwh: 0, maxKwh: 800 }),
      tier({ minKwh: 700, maxKwh: 1_200, panels: 6 }),
    ])
    expect(errors.join(' ')).toContain('se traslapan')
  })

  it('catches an overlap even when the rows are entered out of order', () => {
    const errors = validateTierTable([
      tier({ minKwh: 700, maxKwh: 1_200, panels: 6 }),
      tier({ minKwh: 0, maxKwh: 800 }),
    ])
    expect(errors.join(' ')).toContain('se traslapan')
  })

  // Adjacent, not overlapping: 704 ends where 705 begins. The bot's own
  // table is built this way, so treating it as an error would reject it.
  it('allows ranges that touch without overlapping', () => {
    const errors = validateTierTable([
      tier({ minKwh: 0, maxKwh: 704 }),
      tier({ minKwh: 705, maxKwh: 1_024, panels: 6 }),
    ])
    expect(errors).toEqual([])
  })

  it('allows a gap between ranges', () => {
    const errors = validateTierTable([
      tier({ minKwh: 0, maxKwh: 704 }),
      tier({ minKwh: 900, maxKwh: 1_024, panels: 6 }),
    ])
    expect(errors).toEqual([])
  })

  it('allows a single-value range', () => {
    expect(validateTierTable([tier({ minKwh: 500, maxKwh: 500 })])).toEqual([])
  })
})
