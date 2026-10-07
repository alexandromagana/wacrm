import { describe, expect, it } from 'vitest'

import { panelValueSize } from './stat-type'

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
