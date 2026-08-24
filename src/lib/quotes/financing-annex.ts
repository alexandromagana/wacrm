import { PDFDocument } from 'pdf-lib';
import template from './template.json';
import { renderQuotePdf } from './render';
import type { FieldKey } from './fields';

// ============================================================
// The financing annex, detached from the proposal it belongs to.
//
// The Cotizador fills an account's own .docx/.pptx, which may or may
// not carry a financing section of its own. When the user asks for one,
// we do NOT re-draw it: `renderQuotePdf` already produces the annex the
// bot sends, off the same amortisation and the same branded artwork, so
// this module renders that document and lifts its last page out.
//
// Page surgery only — every decision about what the annex SAYS lives in
// financing.ts / fields.ts, and every decision about where the text
// LANDS lives in render.ts + template.json.
// ============================================================

/**
 * The annex is the last page of the template, not a fixed index — the
 * same convention `render.ts` follows when it validates page count, so
 * a design that grows a sixth page moves this with it rather than
 * silently extracting the wrong sheet.
 */
const ANNEX_PAGE_INDEX = template.pages.length - 1;

/**
 * The rendered proposal, loaded and ready to copy pages out of.
 *
 * Both exports start here and copy independently. Chaining them instead
 * (append calling extract) would serialise and re-parse the annex for
 * nothing — `copyPages` reads from a loaded document, not from bytes.
 *
 * No `registerFontkit` on the destinations below, deliberately:
 * `copyPages` clones the font objects already embedded here, and
 * fontkit is only needed to embed a font from a TTF in the first place.
 */
async function loadAnnexSource(
  values: Record<FieldKey, string>
): Promise<PDFDocument> {
  const { bytes } = await renderQuotePdf(values);
  return PDFDocument.load(bytes);
}

/**
 * The annex on its own, as a one-page landscape PDF.
 *
 * For a .docx template, which this codebase has no in-process converter
 * for and therefore delivers as authored: the annex travels beside it
 * as a second file rather than not at all.
 */
export async function extractFinancingAnnexPage(
  values: Record<FieldKey, string>
): Promise<Uint8Array> {
  const source = await loadAnnexSource(values);
  const out = await PDFDocument.create();
  const [annex] = await out.copyPages(source, [ANNEX_PAGE_INDEX]);
  out.addPage(annex);

  // Named for what this file actually is: it arrives in a chat next to
  // the proposal, where "Propuesta" on both would be a coin toss.
  out.setTitle('Hoja de financiamiento | Gama Energía');
  out.setProducer('wacrm');
  out.setCreationDate(new Date());

  return out.save({ useObjectStreams: true });
}

/**
 * `mainPdfBytes` with the annex added as its final page.
 *
 * For a .pptx template, which is already delivered as one converted
 * PDF: the customer gets a single document ending in the annex, the
 * same shape as the bot's own proposal. The main document's title and
 * producer are left alone — it is still the proposal.
 */
export async function appendFinancingAnnex(
  mainPdfBytes: Uint8Array,
  values: Record<FieldKey, string>
): Promise<Uint8Array> {
  const source = await loadAnnexSource(values);
  const main = await PDFDocument.load(mainPdfBytes);
  const [annex] = await main.copyPages(source, [ANNEX_PAGE_INDEX]);
  main.addPage(annex);
  return main.save({ useObjectStreams: true });
}
