import { describe, expect, it } from 'vitest'

import { heroValueSize, panelValueSize } from './stat-type'

describe('heroValueSize', () => {
  it('gives short counters the full size', () => {
    expect(heroValueSize('43')).toBe('text-[40px] lg:text-[44px]')
    expect(heroValueSize('9,800')).toBe('text-[40px] lg:text-[44px]')
  })

  it('steps down for formatted currency so it stays inside the card', () => {
    expect(heroValueSize('MX$2,544,859')).toBe('text-[28px] lg:text-[30px]')
  })

  it('has a floor for unusually long values', () => {
    expect(heroValueSize('MX$12,345,678,901')).toBe('text-[24px]')
  })
})

describe('panelValueSize', () => {
  it('keeps long currency near the base size on a phone', () => {
    // The pipeline strip is two columns on mobile, so the tile is only
    // ~125px wide; 24px here is what pushed MX$2,544,859 past the edge.
    expect(panelValueSize('MX$2,544,859')).toBe('text-base sm:text-xl xl:text-2xl')
  })

  it('still lets short values grow', () => {
    expect(panelValueSize('70')).toBe('text-xl sm:text-2xl')
  })
})
