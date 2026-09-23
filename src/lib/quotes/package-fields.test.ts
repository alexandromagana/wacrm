import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { buildPackageFieldValues } from './package-fields'
import { renderPackagePdf } from './render'
import { tierForPanels } from './pricing'

// The 12-panel package, whose sheet is the example frame in Figma
// ("★ Ejemplo · Paquete 12 paneles"). Every string below is on it.
const TIER_12 = tierForPanels(12)!
const NOW = new Date('2026-09-23T18:00:00Z')

describe('buildPackageFieldValues', () => {
  const values = buildPackageFieldValues({
    tier: TIER_12,
    folio: 'GE-2026-TEST',
    now: NOW,
  })

  it('prints the package and its price from the table', () => {
    expect(values.paneles).toBe('12')
    expect(values.precio).toBe('$ 106,900')
    expect(values.kwp).toBe('7.5 kWp')
    expect(values.folio).toBe('GE-2026-TEST')
    expect(values.fecha).toBe('23 / 09 / 2026')
  })

  it('prints the same generation the full proposal would', () => {
    // 159.375 kWh per panel per bimester, 12 panels.
    expect(values.kwhGenerados).toBe('1,913 kWh')
  })

  it('names the largest bill the package was sized for', () => {
    expect(values.consumoFrase).toContain('hasta 1,984 kWh al bimestre')
    expect(values.consumoFrase).toContain('Microinversores Hoymiles')
  })

  it('carries the Nuvolt schedule with centavos', () => {
    // 20% surcharge, 10% down, the five PLANES rates.
    expect(values.mensualidad12).toBe('$10,257.23')
    expect(values.mensualidad24).toBe('$5,488.26')
    expect(values.mensualidad36).toBe('$3,945.31')
    expect(values.mensualidad48).toBe('$3,212.53')
    expect(values.mensualidad60).toBe('$2,806.95')
    expect(values.engancheFrase).toMatch(/^Enganche mínimo \$12,828\.00\. /)
  })

  it('says nothing that would need the bill', () => {
    const all = Object.values(values).join(' ')
    expect(all).not.toMatch(/ahorr|CFE|retorno/i)
  })
})

// Unmocked, like financing-annex.test.ts: the real template and fonts are
// on disk, and a page-count or size mismatch is exactly what a mock hides.
describe('renderPackagePdf', () => {
  it('fills the one-page sheet at its design size', async () => {
    const { bytes, pageCount } = await renderPackagePdf(
      buildPackageFieldValues({ tier: TIER_12, folio: 'GE-2026-TEST', now: NOW }),
    )
    expect(pageCount).toBe(1)
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPages()[0].getSize()).toEqual({ width: 816, height: 1056 })
    expect(pdf.getTitle()).toBe('Cotización | Gama Energía')
  })

  it('draws the largest package without throwing', async () => {
    const { pageCount } = await renderPackagePdf(
      buildPackageFieldValues({
        tier: tierForPanels(40)!,
        folio: 'GE-2026-TEST',
        now: NOW,
      }),
    )
    expect(pageCount).toBe(1)
  })
})
