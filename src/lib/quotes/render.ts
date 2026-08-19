import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import template from './template.json';
import { fitRowSize, placeText, type Align, type FieldBox } from './layout';
import { prepareFont, measureText, type TextFont } from './text-font';
import type { FieldKey } from './fields';

// ============================================================
// Draws the resolved quote values onto the branded template.
//
// Thin on purpose: the decisions (which tier, what strings, where the
// text lands) live in pricing/fields/layout, which are pure and tested.
// This module only reads bytes and calls pdf-lib.
// ============================================================

type FontKey = keyof typeof template.fonts;

interface FieldSpec {
  page: number;
  x: number;
  baseline: number;
  size: number;
  font: FontKey;
  color: string;
  align: Align;
  maxWidth?: number;
  minSize?: number;
  /** Fields sharing a `row` are drawn at one common size. */
  row?: string;
}

const FIELDS = template.fields as Record<FieldKey, FieldSpec>;

/**
 * Assets live under public/, which the Dockerfile copies wholesale, and
 * the standalone server chdirs to /app — so cwd-relative resolution
 * holds in dev, in `next start`, and in the container alike. Keeping
 * them out of src/ avoids depending on Next's file tracing to notice a
 * runtime `readFile`.
 */
function assetPath(relative: string): string {
  return join(process.cwd(), 'public', relative);
}

/**
 * Template and font bytes, read once per process. We cache the BYTES,
 * not a PDFDocument: pdf-lib mutates the document as it draws, so every
 * render must load its own copy.
 */
let assetsPromise: Promise<{
  templateBytes: Buffer;
  fonts: Record<FontKey, Buffer>;
}> | null = null;

function loadAssets() {
  assetsPromise ??= (async () => {
    const names = Object.keys(template.fonts) as FontKey[];
    const [templateBytes, ...fontBytes] = await Promise.all([
      readFile(assetPath(template.template)),
      ...names.map((n) => readFile(assetPath(template.fonts[n]))),
    ]);
    const fonts = Object.fromEntries(
      names.map((n, i) => [n, fontBytes[i]])
    ) as Record<FontKey, Buffer>;
    return { templateBytes, fonts };
  })();
  return assetsPromise;
}

function parseColor(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * A font plus a way to handle its space glyph.
 *
 * IBM Plex Mono's space is outline-less, as a space should be — and the
 * frozen @pdf-lib/fontkit fork reads a bounding box from it anyway
 * instead of short-circuiting on the zero-length glyf entry, throwing
 * "Trying to access beyond buffer length" on BOTH measurement and
 * drawing. Archivo happens not to trip it.
 *
 * So: probe each font once, and for the ones that can't do spaces, draw
 * the space-separated runs individually. The substitute advance is the
 * width of "0", which is exact for a monospace face (every advance in
 * Plex Mono measures 6.300 at 10.5pt) — and the only fonts that hit
 * this path are monospace ones.
 */
export interface RenderedQuote {
  bytes: Uint8Array;
  pageCount: number;
}

/**
 * Fill the template with `values` and return the PDF bytes. Throws on
 * any failure — callers decide whether a missing proposal is worth
 * failing the whole conversation over (it isn't).
 */
export async function renderQuotePdf(
  values: Record<FieldKey, string>
): Promise<RenderedQuote> {
  const { templateBytes, fonts } = await loadAssets();

  const pdf = await PDFDocument.load(templateBytes);
  pdf.registerFontkit(fontkit);

  const pages = pdf.getPages();
  if (pages.length !== template.pages.length) {
    throw new Error(
      `template has ${pages.length} pages, expected ${template.pages.length}`
    );
  }
  // A silent re-export at a different size would scatter every field
  // across the page with nothing to show for it, so refuse to draw.
  // Checked per page: the financing annex is landscape while the four
  // pages before it are portrait, so a single expected size would
  // either reject the annex or wave through a rotated re-export.
  for (const [i, page] of pages.entries()) {
    const { width, height } = page.getSize();
    const expected = template.pages[i];
    if (
      Math.round(width) !== expected.width ||
      Math.round(height) !== expected.height
    ) {
      throw new Error(
        `template page ${i + 1} is ${width}x${height}, expected ` +
          `${expected.width}x${expected.height}. Re-run ` +
          'scripts/build-quote-template.mjs after changing the design.'
      );
    }
    if (page.getRotation().angle !== 0) {
      throw new Error(`template page ${i + 1} is rotated`);
    }
  }

  // subset: true is not optional — the full face would otherwise ride
  // along in every quote we generate and store.
  const embedded = {} as Record<FontKey, TextFont>;
  for (const name of Object.keys(fonts) as FontKey[]) {
    embedded[name] = prepareFont(
      await pdf.embedFont(fonts[name], { subset: true })
    );
  }

  const boxOf = (spec: FieldSpec): FieldBox => ({
    x: spec.x,
    baseline: spec.baseline,
    size: spec.size,
    align: spec.align,
    maxWidth: spec.maxWidth,
    minSize: spec.minSize,
  });

  // Rows first: a field that shares a `row` is drawn at the size that
  // fits the WHOLE row, so five instalment columns never print in two
  // different sizes. Blank fields are excluded from the calculation but
  // not from the group — a row is defined by the design, not by which
  // of its values happen to be filled today.
  const entries = Object.entries(FIELDS) as [FieldKey, FieldSpec][];
  const rowSizes = new Map<string, number>();
  for (const row of new Set(entries.map(([, s]) => s.row).filter(Boolean))) {
    const members = entries.filter(([, s]) => s.row === row);
    const tf = embedded[members[0][1].font];
    rowSizes.set(
      row as string,
      fitRowSize({
        boxes: members.map(([, s]) => boxOf(s)),
        texts: members.map(([k]) => values[k] ?? ''),
        measure: (t, size) => measureText(tf, t, size),
      })
    );
  }

  for (const [key, spec] of entries) {
    const text = values[key];
    if (!text) continue; // blank is a legitimate value; draw nothing

    const tf = embedded[spec.font];
    const box = boxOf(spec);
    const placement = placeText({
      box,
      text,
      pageHeight: template.pages[spec.page].height,
      measure: (t, size) => measureText(tf, t, size),
      startSize: spec.row ? rowSizes.get(spec.row) : undefined,
    });

    const style = {
      y: placement.y,
      size: placement.size,
      font: tf.font,
      color: parseColor(spec.color),
    };
    if (!tf.spaceWidthAt) {
      pages[spec.page].drawText(placement.text, { ...style, x: placement.x });
    } else {
      const space = tf.spaceWidthAt(placement.size);
      let x = placement.x;
      for (const run of placement.text.split(' ')) {
        if (run) {
          pages[spec.page].drawText(run, { ...style, x });
          x += tf.font.widthOfTextAtSize(run, placement.size);
        }
        x += space;
      }
    }
  }

  pdf.setTitle('Propuesta — Gama Energía');
  pdf.setProducer('wacrm');
  pdf.setCreationDate(new Date());

  const bytes = await pdf.save({ useObjectStreams: true });
  return { bytes, pageCount: pages.length };
}
