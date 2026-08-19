import type { PDFFont, PDFPage, RGB } from 'pdf-lib';

// ============================================================
// Space-safe text drawing.
//
// The shipped IBMPlexMono-Regular.ttf throws "Trying to access beyond
// buffer length" inside fontkit whenever the space glyph is measured or
// drawn. Every other glyph in the face is fine, and the file is the one
// the design ships, so the renderers step around the space rather than
// swapping the typeface: text is split on spaces, each run is drawn on
// its own, and the gap is advanced by hand.
//
// The substitute width is the width of "0" — exact here, because the
// only face that needs the workaround is monospaced.
// ============================================================

export interface TextFont {
  font: PDFFont;
  /** null when the font handles spaces natively. */
  spaceWidthAt: ((size: number) => number) | null;
}

export function prepareFont(font: PDFFont): TextFont {
  try {
    font.widthOfTextAtSize(' ', 12);
    return { font, spaceWidthAt: null };
  } catch {
    return { font, spaceWidthAt: (size) => font.widthOfTextAtSize('0', size) };
  }
}

export function measureText(tf: TextFont, text: string, size: number): number {
  if (!tf.spaceWidthAt) return tf.font.widthOfTextAtSize(text, size);
  const runs = text.split(' ');
  const runWidth = runs.reduce(
    (sum, run) => sum + (run ? tf.font.widthOfTextAtSize(run, size) : 0),
    0
  );
  return runWidth + tf.spaceWidthAt(size) * (runs.length - 1);
}

/**
 * Draw `text` at `x`/`y`, working around a font that cannot render its
 * own space glyph. Returns the x the text ended at.
 */
export function drawTextRuns(
  page: PDFPage,
  tf: TextFont,
  text: string,
  style: { x: number; y: number; size: number; color: RGB }
): number {
  const { x, y, size, color } = style;
  if (!tf.spaceWidthAt) {
    page.drawText(text, { x, y, size, font: tf.font, color });
    return x + tf.font.widthOfTextAtSize(text, size);
  }
  const space = tf.spaceWidthAt(size);
  let cursor = x;
  for (const run of text.split(' ')) {
    if (run) {
      page.drawText(run, { x: cursor, y, size, font: tf.font, color });
      cursor += tf.font.widthOfTextAtSize(run, size);
    }
    cursor += space;
  }
  return cursor - space;
}
