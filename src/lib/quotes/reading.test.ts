import { describe, it, expect } from 'vitest'
import {
  emptyManualReading,
  hasConsumption,
  parseManualReadings,
  MAX_HISTORIAL_BIMESTRES,
} from './reading'

/**
 * Everything here arrives from a form the user controls, so the point
 * of these tests is the rejections: a payload that slips through
 * half-validated prices a quote off numbers nobody checked.
 */
describe('parseManualReadings', () => {
  it('reads a full block off a JSON string', () => {
    const readings = parseManualReadings(
      JSON.stringify([
        {
          consumo_periodo_actual_kwh: 1611,
          historial_bimestres_kwh: [1220, 683, 328, 655, 1060],
          importe_periodo_mxn: 3634.31,
          importe_dap_mxn: 156.65,
          tarifa: ' 1D ',
          ciudad: 'Cancún',
        },
      ]),
    )
    expect(readings).toHaveLength(1)
    expect(readings![0].consumo_periodo_actual_kwh).toBe(1611)
    expect(readings![0].historial_bimestres_kwh).toEqual([
      1220, 683, 328, 655, 1060,
    ])
    expect(readings![0].tarifa).toBe('1D')
  })

  it('accepts the separators people actually type', () => {
    // Someone copying off the bill types what the bill prints.
    const readings = parseManualReadings([
      {
        consumo_periodo_actual_kwh: '1,611',
        historial_bimestres_kwh: ['1 220'],
        importe_periodo_mxn: '$3,634.31',
      },
    ])
    expect(readings![0].consumo_periodo_actual_kwh).toBe(1611)
    expect(readings![0].historial_bimestres_kwh).toEqual([1220])
    expect(readings![0].importe_periodo_mxn).toBe(3634.31)
  })

  it('drops blanks from the history rather than storing zeroes', () => {
    // The form keeps an emptied field on screen so the caret does not
    // jump; it must not survive the trip as a zero, which would drag the
    // average down and read downstream as an empty house — the exact
    // false alarm this work set out to remove.
    const readings = parseManualReadings([
      { historial_bimestres_kwh: [1220, '', null, 683] },
    ])
    expect(readings![0].historial_bimestres_kwh).toEqual([1220, 683])
  })

  it('sees a meter as blank when every history field was emptied', () => {
    const readings = parseManualReadings([
      { consumo_periodo_actual_kwh: null, historial_bimestres_kwh: ['', ''] },
    ])
    expect(hasConsumption(readings![0])).toBe(false)
  })

  it('keeps the holes in the importes, which are read by index', () => {
    const readings = parseManualReadings([
      {
        historial_bimestres_kwh: [1220, 683],
        historial_bimestres_importe_mxn: [1879, ''],
      },
    ])
    expect(readings![0].historial_bimestres_importe_mxn).toEqual([1879, null])
  })

  it('caps the history at a year', () => {
    const readings = parseManualReadings([
      { historial_bimestres_kwh: [1, 2, 3, 4, 5, 6, 7, 8] },
    ])
    expect(readings![0].historial_bimestres_kwh).toHaveLength(
      MAX_HISTORIAL_BIMESTRES,
    )
  })

  it('refuses negatives, NaN and infinities', () => {
    const readings = parseManualReadings([
      {
        consumo_periodo_actual_kwh: -500,
        historial_bimestres_kwh: [Infinity, NaN, 'abc', 900],
      },
    ])
    expect(readings![0].consumo_periodo_actual_kwh).toBeNull()
    expect(readings![0].historial_bimestres_kwh).toEqual([900])
  })

  it('refuses a payload that is not a list of blocks', () => {
    expect(parseManualReadings('not json')).toBeNull()
    expect(parseManualReadings('{}')).toBeNull()
    expect(parseManualReadings('[]')).toBeNull()
    expect(parseManualReadings([null])).toBeNull()
    expect(parseManualReadings(['1611'])).toBeNull()
  })

  it('refuses more meters than a quote may cover', () => {
    expect(
      parseManualReadings(Array.from({ length: 5 }, () => ({}))),
    ).toBeNull()
  })
})

describe('hasConsumption', () => {
  it('is false for a meter added and left blank', () => {
    expect(hasConsumption(emptyManualReading())).toBe(false)
  })

  it('is true on either the current period or a history value alone', () => {
    expect(
      hasConsumption({
        ...emptyManualReading(),
        consumo_periodo_actual_kwh: 1611,
      }),
    ).toBe(true)
    expect(
      hasConsumption({
        ...emptyManualReading(),
        historial_bimestres_kwh: [1220],
      }),
    ).toBe(true)
  })
})
