import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { appendFinancingAnnex, extractFinancingAnnexPage } from './financing-annex';
import { buildQuoteFieldValues } from './fields';
import { SOLAR_TIERS } from './pricing';

// ============================================================
// Unmocked on purpose: the real template and the real fonts are on
// disk, `renderQuotePdf` already reads them, and what these functions
// can get wrong is precisely the thing a mock would paper over —
// copying the wrong page, or dropping the annex's landscape MediaBox.
// ============================================================

/** The 8-panel tier, the same reference annex financing.test.ts pins. */
const values = buildQuoteFieldValues({
  nombre: 'Cliente de prueba',
  tier: SOLAR_TIERS[2],
  folio: 'GE-2026-TEST',
  now: new Date('2026-08-23T12:00:00Z'),
  // Null on purpose: the annex is priced off the tier alone, so it must
  // come out whole even when the bill was unreadable and page 2's
  // comparison cards are blank.
  financials: null,
});

/** The annex sheet, in points. Landscape, unlike the four before it. */
const ANNEX_SIZE = { width: 1056, height: 816 };

describe('extractFinancingAnnexPage', () => {
  it('returns the annex alone, still landscape', async () => {
    const pdf = await PDFDocument.load(await extractFinancingAnnexPage(values));

    expect(pdf.getPageCount()).toBe(1);
    // The whole risk of copying a page between documents: pdf-lib
    // preserves the source MediaBox, and a portrait annex would mean it
    // did not.
    expect(pdf.getPages()[0].getSize()).toEqual(ANNEX_SIZE);
  });

  it('carries its own title, not the proposal’s', async () => {
    const pdf = await PDFDocument.load(await extractFinancingAnnexPage(values));
    expect(pdf.getTitle()).toContain('financiamiento');
  });
});

describe('appendFinancingAnnex', () => {
  it('adds exactly one page, at the end', async () => {
    const base = await PDFDocument.create();
    base.addPage([612, 792]);
    base.addPage([612, 792]);

    const merged = await PDFDocument.load(
      await appendFinancingAnnex(await base.save(), values)
    );

    expect(merged.getPageCount()).toBe(3);
    expect(merged.getPages()[2].getSize()).toEqual(ANNEX_SIZE);
    // The pages it was handed are still its own, untouched.
    expect(merged.getPages()[0].getSize()).toEqual({ width: 612, height: 792 });
  });
});
