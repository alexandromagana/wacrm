import { describe, it, expect } from 'vitest'
import {
  PLANES,
  PLAZOS,
  PORCENTAJE_ENGANCHE,
  RECARGO_FINANCIAMIENTO,
  buildFinancing,
  financingForTier,
  pagoMensual,
} from './financing'
import { SOLAR_TIERS } from './pricing'

describe('the rates printed on the annex', () => {
  // The template PDF draws these as static text. If this test fails,
  // the artwork in design/ has to change too — the code alone cannot
  // fix it, and shipping the mismatch prints a payment under the wrong
  // rate.
  it('matches the artwork in design/, term for term', () => {
    expect(PLANES).toEqual([
      { meses: 12, tasaAnual: 0.1199 },
      { meses: 24, tasaAnual: 0.1299 },
      { meses: 36, tasaAnual: 0.1399 },
      { meses: 48, tasaAnual: 0.1499 },
      { meses: 60, tasaAnual: 0.1599 },
    ])
    expect(PLAZOS).toEqual([12, 24, 36, 48, 60])
  })

  it('charges more for longer paper', () => {
    const tasas = PLANES.map((p) => p.tasaAnual)
    expect(tasas).toEqual([...tasas].sort((a, b) => a - b))
  })
})

describe('buildFinancing — the reference annex', () => {
  // Every number here is read off the signed-off design:
  // design/★ GE-2026-0042 · Financiamiento (horizontal).svg, which
  // quotes the 8-panel tier. This is the regression that says our
  // arithmetic still agrees with the document sales already sends.
  const f = buildFinancing(75_500)!

  it('recharges 20% and takes 10% of that as the down payment', () => {
    expect(f.precioFinanciadoMxn).toBe(90_600)
    expect(f.engancheMxn).toBe(9_060)
    expect(f.montoAFinanciarMxn).toBe(81_540)
  })

  it('reproduces the five printed instalments to the centavo', () => {
    expect(f.esquema.map((p) => p.mensualidad)).toEqual([
      7_244.35, 3_876.18, 2_786.45, 2_268.91, 1_982.46,
    ])
  })

  it('leaves the down payment out of what it amortises', () => {
    expect(f.engancheMxn + f.montoAFinanciarMxn).toBe(f.precioFinanciadoMxn)
  })
})

describe('buildFinancing — shape', () => {
  it('returns null for a price it cannot finance', () => {
    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildFinancing(price)).toBeNull()
    }
  })

  it('quotes every tier in the table', () => {
    for (const tier of SOLAR_TIERS) {
      const r = financingForTier(tier)!
      expect(r).not.toBeNull()
      expect(r.esquema).toHaveLength(PLANES.length)
      expect(r.precioBaseMxn).toBe(tier.priceMxn)
    }
  })

  it('drops the monthly payment as the term lengthens', () => {
    // True despite the rate RISING with the term — which is the whole
    // sales point of the page, and the reason the "MENSUALIDAD MÁS
    // BAJA" pill is printed over the 60-month column.
    for (const tier of SOLAR_TIERS) {
      const pagos = financingForTier(tier)!.esquema.map((p) => p.mensualidad)
      expect(pagos).toEqual([...pagos].sort((a, b) => b - a))
    }
  })

  it('costs more in total the longer the term runs', () => {
    const { esquema } = buildFinancing(75_500)!
    const totales = esquema.map((p) => p.mensualidad * p.meses)
    expect(totales).toEqual([...totales].sort((a, b) => a - b))
  })

  it('derives the constants it documents', () => {
    const f = buildFinancing(100_000)!
    expect(f.precioFinanciadoMxn).toBe(100_000 * (1 + RECARGO_FINANCIAMIENTO))
    expect(f.engancheMxn).toBe(f.precioFinanciadoMxn * PORCENTAJE_ENGANCHE)
  })
})

describe('pagoMensual', () => {
  it('amortises the principal exactly over the term', () => {
    // Walk the schedule down by hand: interest on the balance, the
    // rest to capital. A correct payment lands the balance on zero.
    const principal = 81_540
    const tasaAnual = 0.1199
    const meses = 12
    const pago = pagoMensual(principal, tasaAnual, meses)
    let saldo = principal
    for (let m = 0; m < meses; m++) {
      saldo = saldo * (1 + tasaAnual / 12) - pago
    }
    expect(saldo).toBeCloseTo(0, 6)
  })

  it('splits the principal evenly at zero interest', () => {
    expect(pagoMensual(1_200, 0, 12)).toBe(100)
  })

  it('returns 0 for a term that is not a term', () => {
    expect(pagoMensual(1_000, 0.12, 0)).toBe(0)
    expect(pagoMensual(1_000, 0.12, -6)).toBe(0)
  })

  it('charges more per month than simple division, always', () => {
    // The sanity check that catches an interest term dropped entirely.
    expect(pagoMensual(81_540, 0.1199, 12)).toBeGreaterThan(81_540 / 12)
  })
})
