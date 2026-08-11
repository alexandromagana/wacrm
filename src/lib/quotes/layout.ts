// ============================================================
// Placing text on the proposal template.
//
// Coordinates come straight out of the Figma SVG export, so they are
// top-origin — and conveniently a <tspan>'s `y` is already the text
// BASELINE, which is exactly what pdf-lib's drawText expects. The whole
// conversion is therefore one subtraction; no cap-height guesswork.
//
// The text measurer is injected so this module is testable without
// pdf-lib, a template, or an embedded font.
// ============================================================

export type Align = 'left' | 'right'

export interface FieldBox {
  /** Left edge for `left`, right edge for `right`. Figma units. */
  x: number
  /** Text baseline, top-origin, straight from the SVG's tspan `y`. */
  baseline: number
  size: number
  align: Align
  /**
   * Widest the text may draw. Omit for fields whose content is bounded
   * by construction (a panel count, a price from a fixed table).
   */
  maxWidth?: number
  /**
   * Floor for shrink-to-fit. Set equal to `size` to forbid shrinking —
   * which is what the numeric fields do, because a silently resized
   * price is worse than one that visibly overflows in review.
   */
  minSize?: number
}

export interface Placement {
  /** Left edge of the drawn text, bottom-origin. */
  x: number
  /** Baseline, bottom-origin. */
  y: number
  size: number
  /** Possibly shrunk-to-fit and ellipsised. */
  text: string
}

export type Measure = (text: string, size: number) => number

const SHRINK_STEP = 0.5
const ELLIPSIS = '...'

/**
 * Fit `text` into `box`: shrink by half-points down to `minSize`, then
 * truncate with an ellipsis. Never wraps — every field on a fixed
 * template is single-line by design, and a second line would collide
 * with the artwork underneath.
 */
function fit(
  text: string,
  box: FieldBox,
  measure: Measure,
): { text: string; size: number } {
  const max = box.maxWidth
  if (max === undefined || measure(text, box.size) <= max) {
    return { text, size: box.size }
  }

  const floor = box.minSize ?? box.size * 0.7
  for (let size = box.size - SHRINK_STEP; size >= floor; size -= SHRINK_STEP) {
    if (measure(text, size) <= max) return { text, size }
  }

  // Longest prefix that still fits with the ellipsis appended.
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(text.slice(0, mid) + ELLIPSIS, floor) <= max) lo = mid
    else hi = mid - 1
  }
  return { text: text.slice(0, lo).trimEnd() + ELLIPSIS, size: floor }
}

export function placeText(args: {
  box: FieldBox
  text: string
  /** Template page height in Figma units — 1056 for these frames. */
  pageHeight: number
  measure: Measure
}): Placement {
  const { box, pageHeight, measure } = args
  const { text, size } = fit(args.text, box, measure)
  const width = measure(text, size)
  return {
    x: box.align === 'right' ? box.x - width : box.x,
    y: pageHeight - box.baseline,
    size,
    text,
  }
}
