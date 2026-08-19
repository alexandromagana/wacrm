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
  startSize: number = box.size,
): { text: string; size: number } {
  const max = box.maxWidth
  if (max === undefined || measure(text, startSize) <= max) {
    return { text, size: startSize }
  }

  const floor = box.minSize ?? box.size * 0.7
  for (let size = startSize - SHRINK_STEP; size >= floor; size -= SHRINK_STEP) {
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
  /**
   * Template page height in Figma units — 1056 for the portrait pages,
   * 816 for the landscape financing annex. Per page, never global.
   */
  pageHeight: number
  measure: Measure
  /**
   * Start shrinking from here instead of `box.size`. Set by callers
   * drawing a ROW of fields that must share one type size; see
   * `fitRowSize`.
   */
  startSize?: number
}): Placement {
  const { box, pageHeight, measure } = args
  const { text, size } = fit(args.text, box, measure, args.startSize)
  const width = measure(text, size)
  return {
    x: box.align === 'right' ? box.x - width : box.x,
    y: pageHeight - box.baseline,
    size,
    text,
  }
}

/**
 * One type size for a whole ROW of fields: the largest that lets every
 * text fit its own box.
 *
 * The financing annex needs this and single-field fitting cannot give
 * it. Its five instalment columns are 176 units wide, and once the
 * monthly payment crosses into five digits — which it does from the
 * 12-panel tier up — the 12-month figure measures 183 at 36 pt while
 * the other four still measure ~162. Shrinking each field on its own
 * would set the first column at 34.5 pt beside four at 36 pt, and a row
 * of five parallel numbers in two different sizes reads as a mistake.
 * So they shrink together or not at all.
 *
 * Every box in the row is expected to share a `size` and `minSize`; the
 * first box's are the ones that count.
 */
export function fitRowSize(args: {
  boxes: readonly FieldBox[]
  /** Positionally matched to `boxes`. Empty strings are skipped. */
  texts: readonly string[]
  measure: Measure
}): number {
  const { boxes, texts, measure } = args
  const first = boxes[0]
  if (!first) return 0

  const floor = first.minSize ?? first.size * 0.7
  const fitsAll = (size: number) =>
    boxes.every((box, i) => {
      const text = texts[i]
      if (!text || box.maxWidth === undefined) return true
      return measure(text, size) <= box.maxWidth
    })

  for (let size = first.size; size > floor; size -= SHRINK_STEP) {
    if (fitsAll(size)) return size
  }
  // Nothing fit down to the floor. Return it anyway and let each
  // field's own `fit` ellipsise — a visible truncation in review beats
  // silently shrinking past the design's stated minimum.
  return floor
}
