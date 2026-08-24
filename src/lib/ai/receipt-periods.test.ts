import { describe, it, expect } from 'vitest'
import {
  parsePeriodoLabel,
  selectRecentHistorial,
  type HistorialCandidate,
} from './receipt-periods'

/**
 * The bill this module exists because of. Every row of the "Consumo
 * histórico" table on page 2, in the order CFE prints it (newest first),
 * plus the period page 1 was billing.
 *
 * Quoted from it: 8 paneles / $75,500, on an average of 1,090 kWh. The
 * true average of the current bimester and the five most recent rows is
 * 864 kWh, which is 6 paneles / $62,400 — a $13,100 difference, on a
 * document the customer keeps.
 */
const MOISES_HISTORIAL: HistorialCandidate[] = [
  { kwh: 1076, importeMxn: 1557, periodo: 'del 10 ABR 26 al 12 JUN 26' },
  { kwh: 446, importeMxn: 834, periodo: 'del 10 FEB 26 al 10 ABR 26' },
  { kwh: 459, importeMxn: 891, periodo: 'del 11 DIC 25 al 10 FEB 26' },
  { kwh: 643, importeMxn: 1758, periodo: 'del 10 OCT 25 al 11 DIC 25' },
  { kwh: 984, importeMxn: 1353, periodo: 'del 12 AGO 25 al 10 OCT 25' },
  { kwh: 1043, importeMxn: 1447, periodo: 'del 11 JUN 25 al 12 AGO 25' },
  { kwh: 1241, importeMxn: 1899, periodo: 'del 09 ABR 25 al 11 JUN 25' },
  { kwh: 1157, importeMxn: 4072, periodo: 'del 07 FEB 25 al 09 ABR 25' },
  { kwh: 860, importeMxn: 2686, periodo: 'del 11 DIC 24 al 07 FEB 25' },
  { kwh: 1397, importeMxn: 5102, periodo: 'del 10 OCT 24 al 11 DIC 24' },
  { kwh: 1450, importeMxn: 2787, periodo: 'del 12 AGO 24 al 10 OCT 24' },
]

const MOISES_CURRENT_KWH = 1574
const MOISES_CURRENT_END = parsePeriodoLabel('12 JUN 26 - 13 AGO 26')!.end

/** The five rows that actually belong in a one-year window. */
const MOISES_TRUE_FIVE = [1076, 446, 459, 643, 984]

describe('parsePeriodoLabel', () => {
  it('reads the layouts a CFE bill actually prints', () => {
    // "del … al …" is the historial table; the bare dash is page 1's
    // "PERIODO FACTURADO". Both have to land on the same dates.
    for (const label of [
      'del 10 ABR 26 al 12 JUN 26',
      '10 ABR 26 - 12 JUN 26',
      '10 ABR 26-12 JUN 26',
    ]) {
      const parsed = parsePeriodoLabel(label)
      expect(parsed, label).not.toBeNull()
      expect(parsed!.start.toISOString().slice(0, 10)).toBe('2026-04-10')
      expect(parsed!.end.toISOString().slice(0, 10)).toBe('2026-06-12')
    }
  })

  it('borrows the year for a start date printed without one', () => {
    const parsed = parsePeriodoLabel('10 ABR - 12 JUN 26')
    expect(parsed!.start.toISOString().slice(0, 10)).toBe('2026-04-10')
  })

  it('rolls the year back when the period crosses into January', () => {
    // The one case where "same year as the end" is wrong. A DIC-FEB
    // bimester starts in the previous year, and getting this wrong sorts
    // the winter row eleven months out of place.
    const parsed = parsePeriodoLabel('11 DIC - 10 FEB 26')
    expect(parsed!.start.toISOString().slice(0, 10)).toBe('2025-12-11')
    expect(parsed!.end.toISOString().slice(0, 10)).toBe('2026-02-10')
  })

  it('is unbothered by case and accents', () => {
    expect(parsePeriodoLabel('Del 10 Abr 26 al 12 Jun 26')).not.toBeNull()
  })

  it('refuses anything that is not a pair of dates', () => {
    expect(parsePeriodoLabel(null)).toBeNull()
    expect(parsePeriodoLabel('')).toBeNull()
    expect(parsePeriodoLabel('bimestre pasado')).toBeNull()
    expect(parsePeriodoLabel('12 JUN 26')).toBeNull() // one date, not a span
    expect(parsePeriodoLabel('10 XYZ 26 - 12 JUN 26')).toBeNull()
  })

  it('refuses a span no billing period could have', () => {
    // The backstop against a mis-parse that happens to produce two valid
    // dates. A year-long "bimester" is a parse failure, not a bill.
    expect(parsePeriodoLabel('12 JUN 25 - 13 AGO 26')).toBeNull()
    expect(parsePeriodoLabel('10 JUN 26 - 12 JUN 26')).toBeNull()
  })
})

describe('selectRecentHistorial — the regression this module exists for', () => {
  it("picks the five most recent rows of Moisés Gómez's bill", () => {
    const result = selectRecentHistorial(
      MOISES_HISTORIAL,
      5,
      MOISES_CURRENT_END,
    )
    expect(result.usedDateOrdering).toBe(true)
    expect(result.selected.map((c) => c.kwh)).toEqual(MOISES_TRUE_FIVE)
    expect(result.warning).toBeNull()
  })

  it('averages to 864 kWh, not the 1,090 that was quoted', () => {
    // The whole point, stated as the number on the document. 864 lands
    // in the 6-panel tier; 1,090 landed in the 8-panel one.
    const result = selectRecentHistorial(
      MOISES_HISTORIAL,
      5,
      MOISES_CURRENT_END,
    )
    const values = [MOISES_CURRENT_KWH, ...result.selected.map((c) => c.kwh)]
    const average = Math.round(
      values.reduce((sum, v) => sum + v, 0) / values.length,
    )
    expect(average).toBe(864)
    expect(average).not.toBe(1090)
  })

  it('sorts rather than trusting the order it was handed', () => {
    // Shuffled input, identical output. If this ever fails, the module
    // has quietly gone back to believing whatever the model reported —
    // which is the bug it was written to remove.
    const shuffled = [...MOISES_HISTORIAL].reverse()
    const result = selectRecentHistorial(shuffled, 5, MOISES_CURRENT_END)
    expect(result.usedDateOrdering).toBe(true)
    expect(result.selected.map((c) => c.kwh)).toEqual(MOISES_TRUE_FIVE)
  })

  it('keeps each row married to its own importe', () => {
    // The money column is read by position downstream. A selection that
    // reorders kWh without carrying the pesos along would price the
    // right system off the wrong bill.
    const result = selectRecentHistorial(
      [...MOISES_HISTORIAL].reverse(),
      5,
      MOISES_CURRENT_END,
    )
    expect(result.selected.map((c) => c.importeMxn)).toEqual([
      1557, 834, 891, 1758, 1353,
    ])
  })
})

describe('selectRecentHistorial — falling back', () => {
  it('takes the reported order when no row carries a date', () => {
    // The hand-capture path: someone typed the numbers off the paper and
    // there are no labels to sort by. Must behave exactly as it did
    // before this module existed.
    const undated = MOISES_HISTORIAL.map((c) => ({ ...c, periodo: null }))
    const result = selectRecentHistorial(undated, 5, MOISES_CURRENT_END)
    expect(result.usedDateOrdering).toBe(false)
    expect(result.selected.map((c) => c.kwh)).toEqual(MOISES_TRUE_FIVE)
  })

  it('falls back on the whole window when a single label is unreadable', () => {
    // All-or-nothing by design: a half-dated window cannot be ordered
    // against itself, and a mix of "sorted" and "wherever it landed"
    // looks authoritative without being it.
    const partial = MOISES_HISTORIAL.map((c, i) =>
      i === 3 ? { ...c, periodo: 'ilegible' } : c,
    )
    const result = selectRecentHistorial(partial, 5, MOISES_CURRENT_END)
    expect(result.usedDateOrdering).toBe(false)
    expect(result.selected).toHaveLength(5)
  })

  it('handles an empty history and a zero limit without throwing', () => {
    expect(selectRecentHistorial([], 5).selected).toEqual([])
    expect(selectRecentHistorial(MOISES_HISTORIAL, 0).selected).toEqual([])
  })

  it('works with no current period to compare against', () => {
    // Page 1 unreadable, page 2 fine. The dates still order the window;
    // there is just nothing to check them against.
    const result = selectRecentHistorial(MOISES_HISTORIAL, 5, null)
    expect(result.usedDateOrdering).toBe(true)
    expect(result.selected.map((c) => c.kwh)).toEqual(MOISES_TRUE_FIVE)
  })
})

describe('selectRecentHistorial — what it reports back', () => {
  it('drops a row that repeats the period being billed', () => {
    // Some bills list the current bimester in the historial too. Left
    // in, it would weight that period double in the average.
    const withCurrent: HistorialCandidate[] = [
      { kwh: 1574, importeMxn: 3612, periodo: 'del 12 JUN 26 al 13 AGO 26' },
      ...MOISES_HISTORIAL,
    ]
    const result = selectRecentHistorial(withCurrent, 5, MOISES_CURRENT_END)
    expect(result.selected.map((c) => c.kwh)).toEqual(MOISES_TRUE_FIVE)
    expect(result.warning).toMatch(/no es anterior al periodo facturado/)
  })

  it('reports a window that skips bimesters', () => {
    // A gap ages the average without looking like anything is wrong.
    const gapped: HistorialCandidate[] = [
      { kwh: 1076, importeMxn: null, periodo: 'del 10 ABR 26 al 12 JUN 26' },
      { kwh: 984, importeMxn: null, periodo: 'del 12 AGO 25 al 10 OCT 25' },
    ]
    const result = selectRecentHistorial(gapped, 5, MOISES_CURRENT_END)
    expect(result.usedDateOrdering).toBe(true)
    expect(result.warning).toMatch(/salta bimestres/)
  })

  it('reports and drops a repeated bimester', () => {
    const duplicated: HistorialCandidate[] = [
      MOISES_HISTORIAL[0],
      { ...MOISES_HISTORIAL[0], kwh: 1080 },
      MOISES_HISTORIAL[1],
    ]
    const result = selectRecentHistorial(duplicated, 5, MOISES_CURRENT_END)
    expect(result.selected.map((c) => c.kwh)).toEqual([1076, 446])
    expect(result.warning).toMatch(/repetido/)
  })
})
