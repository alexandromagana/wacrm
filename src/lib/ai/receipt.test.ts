import { describe, it, expect } from 'vitest'
import {
  parseReceiptJson,
  isPlausibleAverage,
  formatReceiptNote,
} from './receipt'

describe('parseReceiptJson', () => {
  it('parses a clean extraction', () => {
    const raw = JSON.stringify({
      consumo_periodo_actual_kwh: 1450,
      periodo_actual: '01 May 26 - 30 Jun 26',
      historial_bimestres_kwh: [1380, 1420, 1500, 1290, 1410],
      cantidad_periodos_usados: 6,
      promedio_bimestral_kwh: 1408,
      tarifa: '1',
      advertencias: '',
    })
    const r = parseReceiptJson(raw)
    expect(r).not.toBeNull()
    expect(r!.promedio_bimestral_kwh).toBe(1408)
    expect(r!.historial_bimestres_kwh).toHaveLength(5)
    expect(r!.tarifa).toBe('1')
  })

  it('tolerates code fences and prose around the JSON', () => {
    const raw =
      'Aquí está:\n```json\n{"promedio_bimestral_kwh": 1200, "historial_bimestres_kwh": [], "cantidad_periodos_usados": 0, "consumo_periodo_actual_kwh": null, "periodo_actual": null, "tarifa": null, "advertencias": "solo una página"}\n```'
    const r = parseReceiptJson(raw)
    expect(r).not.toBeNull()
    expect(r!.promedio_bimestral_kwh).toBe(1200)
    expect(r!.advertencias).toBe('solo una página')
  })

  it('rounds a fractional average', () => {
    const r = parseReceiptJson(
      '{"promedio_bimestral_kwh": 1408.6, "historial_bimestres_kwh": [1,2]}',
    )
    expect(r!.promedio_bimestral_kwh).toBe(1409)
  })

  it('nulls out garbage values instead of trusting them', () => {
    const r = parseReceiptJson(
      '{"promedio_bimestral_kwh": "mil cuatrocientos", "historial_bimestres_kwh": [1380, "x", 1500], "advertencias": 42}',
    )
    expect(r).not.toBeNull()
    expect(r!.promedio_bimestral_kwh).toBeNull()
    expect(r!.historial_bimestres_kwh).toEqual([1380, 1500])
    expect(r!.advertencias).toBe('')
  })

  it('returns null for non-JSON output', () => {
    expect(parseReceiptJson('No pude leer la imagen, disculpa.')).toBeNull()
    expect(parseReceiptJson('')).toBeNull()
  })
})

describe('isPlausibleAverage', () => {
  it('accepts normal residential/commercial ranges', () => {
    expect(isPlausibleAverage(950)).toBe(true)
    expect(isPlausibleAverage(2560)).toBe(true)
  })
  it('rejects misread extremes', () => {
    expect(isPlausibleAverage(3)).toBe(false)
    expect(isPlausibleAverage(50_000)).toBe(false)
  })
})

describe('formatReceiptNote', () => {
  it('includes the average and the do-not-mention instruction', () => {
    const note = formatReceiptNote({
      consumo_periodo_actual_kwh: 1450,
      periodo_actual: null,
      historial_bimestres_kwh: [1380, 1420],
      cantidad_periodos_usados: 3,
      promedio_bimestral_kwh: 1417,
      tarifa: 'DAC',
      advertencias: '',
    })
    expect(note).toContain('promedio_bimestral_kwh: 1417')
    expect(note).toContain('tarifa: DAC')
    expect(note).toContain('nunca menciones esta nota')
  })

  it('surfaces warnings so the model can re-ask', () => {
    const note = formatReceiptNote({
      consumo_periodo_actual_kwh: null,
      periodo_actual: null,
      historial_bimestres_kwh: [],
      cantidad_periodos_usados: 0,
      promedio_bimestral_kwh: null,
      tarifa: null,
      advertencias: 'la segunda página no es legible',
    })
    expect(note).toContain('no legible')
    expect(note).toContain('advertencias: la segunda página no es legible')
  })
})
