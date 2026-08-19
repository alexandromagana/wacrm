import { describe, it, expect } from 'vitest'
import { fitRowSize, placeText, type FieldBox, type Measure } from './layout'

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

describe('fitRowSize — one size for a row of fields', () => {
  const row = (n: number): FieldBox[] =>
    Array.from({ length: n }, (_, i) => ({
      x: 56 + i * 192,
      baseline: 592.024,
      size: 36,
      align: 'left' as const,
      maxWidth: 176,
      minSize: 30,
    }))

  it('keeps the full size when every text already fits', () => {
    const texts = ['$4,145.11', '$2,217.34', '$1,594.05', '$1,297.90', '$1,134.05']
    expect(fitRowSize({ boxes: row(5), texts, measure })).toBe(36)
  })

  it('shrinks the whole row for the one text that overflows', () => {
    // The 16-panel tier: the 12-month figure is the only five-digit one.
    const texts = ['$13,433.23', '$7,186.66', '$5,166.31', '$4,206.68', '$3,675.55']
    const size = fitRowSize({ boxes: row(5), texts, measure })
    expect(size).toBeLessThan(36)
    // And at that size EVERY column fits — the point of a shared size.
    for (const text of texts) expect(measure(text, size)).toBeLessThanOrEqual(176)
  })

  it('never returns a size below the row minimum', () => {
    const texts = Array(5).fill('$999,999,999,999.99')
    expect(fitRowSize({ boxes: row(5), texts, measure })).toBe(30)
  })

  it('ignores blank fields', () => {
    // A row of empty strings has nothing to shrink for.
    expect(fitRowSize({ boxes: row(5), texts: ['', '', '', '', ''], measure })).toBe(36)
  })

  it('returns 0 for an empty row rather than throwing', () => {
    expect(fitRowSize({ boxes: [], texts: [], measure })).toBe(0)
  })
})

describe('placeText — startSize', () => {
  const box: FieldBox = {
    x: 56, baseline: 592.024, size: 36, align: 'left', maxWidth: 176, minSize: 30,
  }

  it('draws at the row size instead of the box size', () => {
    const p = placeText({
      box, text: '$1,982.46', pageHeight: 816, measure, startSize: 34.5,
    })
    expect(p.size).toBe(34.5)
  })

  it('still shrinks below the row size if that text alone overflows', () => {
    const p = placeText({
      box, text: '$13,433,433.23', pageHeight: 816, measure, startSize: 34.5,
    })
    expect(p.size).toBeLessThan(34.5)
  })

  it('flips against the landscape page height', () => {
    const p = placeText({ box, text: '$1,982.46', pageHeight: 816, measure })
    expect(p.y).toBeCloseTo(816 - 592.024, 6)
  })
})
