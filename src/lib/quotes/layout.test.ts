import { describe, it, expect } from 'vitest'
import { placeText, type FieldBox, type Measure } from './layout'

/** Every glyph half an em wide — enough to exercise the geometry. */
const measure: Measure = (text, size) => text.length * size * 0.5

const PAGE_H = 1056

describe('placeText — coordinate conversion', () => {
  it('flips the baseline from top-origin to bottom-origin', () => {
    // The A2 price sits at baseline 204.372 measured from the top.
    const box: FieldBox = { x: 60, baseline: 204.372, size: 58, align: 'left' }
    const p = placeText({ box, text: '$ 95,000', pageHeight: PAGE_H, measure })
    expect(p.y).toBeCloseTo(1056 - 204.372, 6)
    expect(p.x).toBe(60)
  })

  it('keeps the left edge for left-aligned text regardless of length', () => {
    const box: FieldBox = { x: 60, baseline: 846, size: 36, align: 'left' }
    for (const text of ['4', '16', '625 W']) {
      expect(placeText({ box, text, pageHeight: PAGE_H, measure }).x).toBe(60)
    }
  })
})

describe('placeText — right alignment', () => {
  // The A1 header block: folio, date and validity all end at x=756.
  const box: FieldBox = { x: 756, baseline: 61.9375, size: 10.5, align: 'right' }

  it('ends the text at the given right edge', () => {
    const text = 'GE-2026-4F7A'
    const p = placeText({ box, text, pageHeight: PAGE_H, measure })
    expect(p.x + measure(text, p.size)).toBeCloseTo(756, 6)
  })

  it('shifts the left edge as the text grows', () => {
    const short = placeText({ box, text: 'GE-1', pageHeight: PAGE_H, measure })
    const long = placeText({
      box,
      text: 'GE-2026-4F7A',
      pageHeight: PAGE_H,
      measure,
    })
    expect(long.x).toBeLessThan(short.x)
    // Both still finish flush on the same edge.
    expect(short.x + measure(short.text, short.size)).toBeCloseTo(756, 6)
    expect(long.x + measure(long.text, long.size)).toBeCloseTo(756, 6)
  })
})

describe('placeText — overflow', () => {
  // The name column runs from x=60 to the folio column at x=292.
  const box: FieldBox = {
    x: 60,
    baseline: 917.509,
    size: 13.5,
    align: 'left',
    maxWidth: 220,
    minSize: 9,
  }

  it('leaves text that already fits untouched', () => {
    const p = placeText({ box, text: 'Ana Jisa', pageHeight: PAGE_H, measure })
    expect(p.size).toBe(13.5)
    expect(p.text).toBe('Ana Jisa')
  })

  it('shrinks a slightly long name instead of truncating it', () => {
    // 33 chars → 222.75 at full size, just over the 220 limit.
    const text = 'María Fernanda Villaseñor Aguilar'
    const p = placeText({ box, text, pageHeight: PAGE_H, measure })
    expect(p.text).toBe(text)
    expect(p.size).toBeLessThan(13.5)
    expect(p.size).toBeGreaterThanOrEqual(9)
    expect(measure(p.text, p.size)).toBeLessThanOrEqual(220)
  })

  it('truncates with an ellipsis once it bottoms out at minSize', () => {
    const text = 'Juan Carlos Alberto de la Torre y Villaseñor Hernández'
    const p = placeText({ box, text, pageHeight: PAGE_H, measure })
    expect(p.size).toBe(9)
    expect(p.text.endsWith('...')).toBe(true)
    expect(p.text.length).toBeLessThan(text.length)
    expect(measure(p.text, p.size)).toBeLessThanOrEqual(220)
  })

  it('never shrinks a field whose minSize equals its size', () => {
    // Numeric fields opt out: a quietly resized price is worse than one
    // that visibly overflows and gets caught in review.
    const rigid: FieldBox = {
      x: 60,
      baseline: 204.372,
      size: 58,
      align: 'left',
      maxWidth: 100,
      minSize: 58,
    }
    const p = placeText({
      box: rigid,
      text: '$ 140,000',
      pageHeight: PAGE_H,
      measure,
    })
    expect(p.size).toBe(58)
  })

  it('does not constrain a box with no maxWidth', () => {
    const box: FieldBox = { x: 60, baseline: 846, size: 36, align: 'left' }
    const text = 'a'.repeat(200)
    const p = placeText({ box, text, pageHeight: PAGE_H, measure })
    expect(p.text).toBe(text)
    expect(p.size).toBe(36)
  })
})
