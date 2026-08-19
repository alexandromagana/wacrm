import { describe, it, expect } from 'vitest'
import {
  formatKwh,
  formatMxn,
  formatKwp,
  formatQuoteDate,
  buildFolio,
  sanitizeForPdf,
  buildQuoteFieldValues,
  formatPaybackDuration,
} from './fields'
import { SOLAR_TIERS } from './pricing'
import { buildFinancials } from './finance'

const TIER_10 = SOLAR_TIERS.find((t) => t.panels === 10)!

describe('number formatting', () => {
  // Exact strings, pinned to es-MX. If an ICU change ever alters the
  // grouping we want a red test, not a wrong-looking PDF.
  it('groups thousands the Mexican way', () => {
    expect(formatKwh(1_450)).toBe('1,450')
    expect(formatKwh(704)).toBe('704')
    expect(formatKwh(1_450.6)).toBe('1,451')
  })

  it('formats pesos with the design spacing and no centavos', () => {
    expect(formatMxn(95_000)).toBe('$ 95,000')
    expect(formatMxn(140_000)).toBe('$ 140,000')
    expect(formatMxn(43_200.4)).toBe('$ 43,200')
  })

  it('trims trailing zeros on system size', () => {
    expect(formatKwp(6.25)).toBe('6.25 kWp')
    expect(formatKwp(5)).toBe('5 kWp')
    expect(formatKwp(3.75)).toBe('3.75 kWp')
  })

  it('emits no non-breaking spaces that a TTF might lack', () => {
    for (const s of [formatMxn(95_000), formatKwh(1_450), formatKwp(6.25)]) {
      expect(s).not.toMatch(/[   ]/)
    }
  })
})

describe('formatQuoteDate', () => {
  it('renders day / month / year spaced like the template', () => {
    // 2026-08-11T18:00Z is still the 11th in Cancún (UTC-5).
    expect(formatQuoteDate(new Date('2026-08-11T18:00:00Z'))).toBe(
      '11 / 08 / 2026',
    )
  })

  it('uses Cancún time, not UTC', () => {
    // 03:00Z on the 12th is 22:00 on the 11th in Cancún.
    expect(formatQuoteDate(new Date('2026-08-12T03:00:00Z'))).toBe(
      '11 / 08 / 2026',
    )
  })

  it('zero-pads single-digit days and months', () => {
    expect(formatQuoteDate(new Date('2026-01-05T18:00:00Z'))).toBe(
      '05 / 01 / 2026',
    )
  })
})

describe('buildFolio', () => {
  const now = new Date('2026-08-11T18:00:00Z')

  it('is stable for the same contact', () => {
    // A re-send must not mint a new folio — sales quotes it by phone.
    expect(buildFolio(now, 'contact-abc')).toBe(buildFolio(now, 'contact-abc'))
  })

  it('differs between contacts', () => {
    expect(buildFolio(now, 'contact-abc')).not.toBe(
      buildFolio(now, 'contact-xyz'),
    )
  })

  it('matches the template shape', () => {
    expect(buildFolio(now, 'contact-abc')).toMatch(/^GE-2026-[0-9A-Z]{4}$/)
  })
})

describe('formatPaybackDuration', () => {
  it('agrees in number, both words', () => {
    expect(formatPaybackDuration(2, 1)).toBe('2 años 1 mes')
    expect(formatPaybackDuration(1, 11)).toBe('1 año 11 meses')
    expect(formatPaybackDuration(1, 1)).toBe('1 año 1 mes')
  })

  it('drops the zero term instead of printing it', () => {
    // "3 años 0 meses" reads like a bug on a sales document.
    expect(formatPaybackDuration(3, 0)).toBe('3 años')
    expect(formatPaybackDuration(0, 8)).toBe('8 meses')
  })

  it('has something to say when both terms are zero', () => {
    expect(formatPaybackDuration(0, 0)).toBe('menos de un mes')
  })
})

describe('sanitizeForPdf', () => {
  it('composes decomposed accents', () => {
    // "José" typed as J-o-s-e-U+0301 has no glyph for the lone accent.
    const decomposed = 'José'
    expect(decomposed).toHaveLength(5)
    expect(sanitizeForPdf(decomposed)).toBe('José')
    expect(sanitizeForPdf(decomposed)).toHaveLength(4)
  })

  it('keeps Spanish characters intact', () => {
    expect(sanitizeForPdf('Muñoz Peña ¿Sí? ¡Órale! Cancún')).toBe(
      'Muñoz Peña ¿Sí? ¡Órale! Cancún',
    )
  })

  it('replaces typographic punctuation with plain equivalents', () => {
    expect(sanitizeForPdf('“Hola” — es’ raro…')).toBe('"Hola" - es\' raro...')
  })

  it('normalises exotic spaces and strips control characters', () => {
    expect(sanitizeForPdf('a b c')).toBe('a b c')
    expect(sanitizeForPdf('a\u0000b\u0007c')).toBe('abc')
  })

  it('collapses whitespace runs and trims', () => {
    expect(sanitizeForPdf('  Juan   Pérez \n ')).toBe('Juan Pérez')
  })
})

describe('buildQuoteFieldValues', () => {
  const base = {
    tier: TIER_10,
    folio: 'GE-2026-4F7A',
    now: new Date('2026-08-11T18:00:00Z'),
    financials: null,
  }

  it('produces every drawable string for a normal quote', () => {
    expect(buildQuoteFieldValues({ ...base, nombre: 'Ana Jisa' })).toEqual({
      nombre: 'Ana Jisa',
      folioPortada: 'GE-2026-4F7A',
      folio: 'GE-2026-4F7A',
      fecha: '11 / 08 / 2026',
      paneles: '10',
      wattsPorPanel: '625 W',
      kwp: '6.25 kWp',
      precio: '$ 95,000',
      precotizacion:
        'PRECOTIZACIÓN GE-2026-4F7A  ·  VIGENCIA 15 DÍAS NATURALES',
      // No readable bill: every financial field blank, none invented.
      gastoSinBimestre: '',
      gastoSin12Meses: '',
      gastoSin25Anios: '',
      gastoConBimestre: '',
      gastoCon12Meses: '',
      gastoCon25Anios: '',
      ahorro25Anios: '',
      payback: '',
      paybackNota: '',
      kwhGenerados: '',
      // The annex fills in regardless: it is priced off the tier, not
      // off the bill the customer never sent.
      folioFinanciamiento: 'GE-2026-4F7A',
      sistemaFinanciado: '10 paneles de 625 W con microinversores Hoymiles',
      enganche: '$11,400.00',
      mensualidad12: '$9,115.41',
      mensualidad24: '$4,877.31',
      mensualidad36: '$3,506.13',
      mensualidad48: '$2,854.91',
      mensualidad60: '$2,494.49',
    })
  })

  it('prices the annex off the tier even with no readable bill', () => {
    // $95,000 x 1.20 = $114,000; 10% of that is the down payment.
    const v = buildQuoteFieldValues({ ...base, nombre: null })
    expect(v.enganche).toBe('$11,400.00')
    expect(v.gastoSinBimestre).toBe('') // the bill-driven half stays blank
  })

  it('repeats the folio on the annex', () => {
    const v = buildQuoteFieldValues({ ...base, nombre: null })
    expect(v.folioFinanciamiento).toBe(v.folio)
  })

  it('names the annex system from the tier', () => {
    for (const tier of SOLAR_TIERS) {
      const v = buildQuoteFieldValues({ ...base, tier, nombre: null })
      expect(v.sistemaFinanciado).toBe(
        `${tier.panels} paneles de 625 W con microinversores Hoymiles`,
      )
    }
  })

  it('fills the comparison cards when the bill was readable', () => {
    const tier = SOLAR_TIERS.find((t) => t.panels === 14)!
    const v = buildQuoteFieldValues({
      ...base,
      tier,
      nombre: 'Osvaldo Coyac',
      financials: buildFinancials({ costoBimestralMxn: 10_237.3, tier })!,
    })
    expect(v.gastoSinBimestre).toBe('$ 10,237')
    expect(v.gastoSin12Meses).toBe('$ 61,424')
    expect(v.gastoSin25Anios).toBe('$ 2,392,448')
    expect(v.gastoConBimestre).toBe('$ 65')
    expect(v.gastoCon12Meses).toBe('$ 390')
    expect(v.gastoCon25Anios).toBe('$ 142,190')
    expect(v.ahorro25Anios).toBe('$ 2,250,258')
    expect(v.payback).toBe('El sistema se paga solo en 2 años 1 mes. A partir')
    expect(v.paybackNota).toContain('todo lo que produce tu techo')
    expect(v.kwhGenerados).toBe('2,231 kWh')
  })

  it('blanks the static payback line too when there is no projection', () => {
    // Half the sentence on its own would read as a rendering bug.
    const v = buildQuoteFieldValues({ ...base, nombre: 'A' })
    expect(v.payback).toBe('')
    expect(v.paybackNota).toBe('')
  })

  it('keeps the page-3 header a fixed width so it stays put', () => {
    // Drawn left-aligned at the design's x, which only works because
    // the folio is always 12 characters in a monospace face.
    const a = buildQuoteFieldValues({ ...base, nombre: 'A' }).precotizacion
    const b = buildQuoteFieldValues({
      ...base,
      folio: 'GE-2026-ZZZZ',
      nombre: 'A',
    }).precotizacion
    expect(a).toHaveLength(b.length)
  })

  it('leaves the name blank rather than printing "null"', () => {
    const values = buildQuoteFieldValues({ ...base, nombre: null })
    expect(values.nombre).toBe('')
    expect(values.nombre).not.toContain('null')
  })

  it('sanitises the name it was given', () => {
    const values = buildQuoteFieldValues({ ...base, nombre: '  José  ' })
    expect(values.nombre).toBe('José')
  })

  it('carries the panel count and price from the tier, unmodified', () => {
    for (const tier of SOLAR_TIERS) {
      const v = buildQuoteFieldValues({ ...base, tier, nombre: 'X' })
      expect(v.paneles).toBe(String(tier.panels))
      expect(v.precio).toContain(tier.priceMxn.toLocaleString('es-MX'))
    }
  })
})
