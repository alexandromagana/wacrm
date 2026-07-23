import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  parseReceiptJson,
  isPlausibleAverage,
  formatReceiptNote,
  inferPropertyType,
  saveReceiptData,
  CONSUMO_FIELD_NAME,
  type ReceiptExtraction,
} from './receipt'
import { CIUDAD_FIELD_NAME, PROPIEDAD_FIELD_NAME } from '@/lib/contacts/lead-form'

/**
 * Minimal in-memory fake covering exactly the two tables + chains
 * upsertField uses: find-or-create on custom_fields, then a
 * conditional read + upsert on contact_custom_values.
 */
function fakeDb(seed: {
  fields?: { id: string; account_id: string; field_name: string }[]
  values?: { contact_id: string; custom_field_id: string; value: string }[]
} = {}) {
  const fields: Record<string, unknown>[] = [...(seed.fields ?? [])]
  const values: Record<string, unknown>[] = [...(seed.values ?? [])]
  let nextId = 0

  function table(rows: Record<string, unknown>[], onInsert?: (p: Record<string, unknown>) => Record<string, unknown>) {
    let filters: [string, unknown][] = []
    const chain = {
      select: () => chain,
      eq: (k: string, v: unknown) => {
        filters = [...filters, [k, v]]
        return chain
      },
      maybeSingle: () => {
        const match = rows.find((r) => filters.every(([k, v]) => r[k] === v))
        filters = []
        return Promise.resolve({ data: match ?? null, error: null })
      },
      insert: (payload: Record<string, unknown>) => {
        const created = onInsert!(payload)
        return {
          select: () => ({
            single: () => Promise.resolve({ data: created, error: null }),
          }),
        }
      },
      upsert: (payload: Record<string, unknown>) => {
        const idx = rows.findIndex(
          (r) =>
            r.contact_id === payload.contact_id &&
            r.custom_field_id === payload.custom_field_id,
        )
        if (idx >= 0) rows[idx] = { ...rows[idx], ...payload }
        else rows.push(payload)
        return Promise.resolve({ error: null })
      },
    }
    return chain
  }

  const db = {
    from: (name: string) =>
      name === 'custom_fields'
        ? table(fields, (payload) => {
            const created = { id: `field-${++nextId}`, ...payload }
            fields.push(created)
            return created
          })
        : table(values),
  } as unknown as SupabaseClient

  return { db, fields, values }
}

function extraction(overrides: Partial<ReceiptExtraction> = {}): ReceiptExtraction {
  return {
    consumo_periodo_actual_kwh: null,
    periodo_actual: null,
    historial_bimestres_kwh: [],
    cantidad_periodos_usados: 0,
    promedio_bimestral_kwh: null,
    tarifa: null,
    ciudad: null,
    advertencias: '',
    ...overrides,
  }
}

describe('parseReceiptJson', () => {
  it('parses a clean extraction', () => {
    const raw = JSON.stringify({
      consumo_periodo_actual_kwh: 1450,
      periodo_actual: '01 May 26 - 30 Jun 26',
      historial_bimestres_kwh: [1380, 1420, 1500, 1290, 1410],
      cantidad_periodos_usados: 6,
      promedio_bimestral_kwh: 1408,
      tarifa: '1',
      ciudad: 'Cancún',
      advertencias: '',
    })
    const r = parseReceiptJson(raw)
    expect(r).not.toBeNull()
    expect(r!.promedio_bimestral_kwh).toBe(1408)
    expect(r!.historial_bimestres_kwh).toHaveLength(5)
    expect(r!.tarifa).toBe('1')
    expect(r!.ciudad).toBe('Cancún')
  })

  it('tolerates code fences and prose around the JSON', () => {
    const raw =
      'Aquí está:\n```json\n{"promedio_bimestral_kwh": 1200, "historial_bimestres_kwh": [], "cantidad_periodos_usados": 0, "consumo_periodo_actual_kwh": null, "periodo_actual": null, "tarifa": null, "ciudad": null, "advertencias": "solo una página"}\n```'
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
      '{"promedio_bimestral_kwh": "mil cuatrocientos", "historial_bimestres_kwh": [1380, "x", 1500], "advertencias": 42, "ciudad": 123}',
    )
    expect(r).not.toBeNull()
    expect(r!.promedio_bimestral_kwh).toBeNull()
    expect(r!.historial_bimestres_kwh).toEqual([1380, 1500])
    expect(r!.advertencias).toBe('')
    expect(r!.ciudad).toBeNull()
  })

  it('trims ciudad and nulls out a blank string', () => {
    expect(parseReceiptJson('{"ciudad": "  Cancún  "}')!.ciudad).toBe('Cancún')
    expect(parseReceiptJson('{"ciudad": "   "}')!.ciudad).toBeNull()
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

describe('inferPropertyType', () => {
  it('maps residential tariffs to Casa', () => {
    expect(inferPropertyType('1')).toBe('Casa')
    expect(inferPropertyType('1A')).toBe('Casa')
    expect(inferPropertyType('1f')).toBe('Casa') // case-insensitive
    expect(inferPropertyType('DAC')).toBe('Casa')
  })

  it('maps small-business tariff to Negocio', () => {
    expect(inferPropertyType('PDBT')).toBe('Negocio')
  })

  it('maps large-demand tariffs to Industria', () => {
    expect(inferPropertyType('GDMTH')).toBe('Industria')
    expect(inferPropertyType('GDBT')).toBe('Industria')
  })

  it('returns null for missing or unrecognized codes rather than guessing', () => {
    expect(inferPropertyType(null)).toBeNull()
    expect(inferPropertyType('')).toBeNull()
    expect(inferPropertyType('XYZ')).toBeNull()
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
      ciudad: null,
      advertencias: '',
    })
    expect(note).toContain('promedio_bimestral_kwh: 1417')
    expect(note).toContain('tarifa: DAC')
    expect(note).toContain('nunca menciones esta nota')
  })

  it('surfaces the detected city and the inferred property type, with the do-not-reask note', () => {
    const note = formatReceiptNote({
      consumo_periodo_actual_kwh: 1450,
      periodo_actual: null,
      historial_bimestres_kwh: [],
      cantidad_periodos_usados: 1,
      promedio_bimestral_kwh: 1450,
      tarifa: '1A',
      ciudad: 'Cancún',
      advertencias: '',
    })
    expect(note).toContain('ciudad_detectada: Cancún')
    expect(note).toContain('tipo_propiedad_sugerido: Casa')
    expect(note).toContain('no la vuelvas a preguntar')
    expect(note).toContain('no lo vuelvas a preguntar')
  })

  it('omits city/property lines when neither was detected', () => {
    const note = formatReceiptNote({
      consumo_periodo_actual_kwh: null,
      periodo_actual: null,
      historial_bimestres_kwh: [],
      cantidad_periodos_usados: 0,
      promedio_bimestral_kwh: 900,
      tarifa: null,
      ciudad: null,
      advertencias: '',
    })
    expect(note).not.toContain('ciudad_detectada')
    expect(note).not.toContain('tipo_propiedad_sugerido')
  })

  it('surfaces warnings so the model can re-ask', () => {
    const note = formatReceiptNote({
      consumo_periodo_actual_kwh: null,
      periodo_actual: null,
      historial_bimestres_kwh: [],
      cantidad_periodos_usados: 0,
      promedio_bimestral_kwh: null,
      tarifa: null,
      ciudad: null,
      advertencias: 'la segunda página no es legible',
    })
    expect(note).toContain('no legible')
    expect(note).toContain('advertencias: la segunda página no es legible')
  })
})

describe('saveReceiptData', () => {
  const ARGS = { accountId: 'acct-1', userId: 'user-1', contactId: 'contact-1' }

  it('creates the fields and writes consumo + ciudad + tipo on a fresh contact', async () => {
    const { db, fields, values } = fakeDb()
    await saveReceiptData(db, {
      ...ARGS,
      extraction: extraction({
        promedio_bimestral_kwh: 1417,
        ciudad: 'Cancún',
        tarifa: '1A',
      }),
    })

    const byName = (name: string) => fields.find((f) => f.field_name === name)
    expect(byName(CONSUMO_FIELD_NAME)).toBeTruthy()
    expect(byName(CIUDAD_FIELD_NAME)).toBeTruthy()
    expect(byName(PROPIEDAD_FIELD_NAME)).toBeTruthy()

    const valueFor = (fieldName: string) =>
      values.find((v) => v.custom_field_id === byName(fieldName)!.id)?.value
    expect(valueFor(CONSUMO_FIELD_NAME)).toBe('1417')
    expect(valueFor(CIUDAD_FIELD_NAME)).toBe('Cancún')
    expect(valueFor(PROPIEDAD_FIELD_NAME)).toBe('Casa') // tarifa 1A → residencial
  })

  it('always overwrites consumo with the newest reading', async () => {
    const field = { id: 'f-consumo', account_id: 'acct-1', field_name: CONSUMO_FIELD_NAME }
    const { db, values } = fakeDb({
      fields: [field],
      values: [{ contact_id: 'contact-1', custom_field_id: 'f-consumo', value: '900' }],
    })
    await saveReceiptData(db, {
      ...ARGS,
      extraction: extraction({ promedio_bimestral_kwh: 1500 }),
    })
    expect(values.find((v) => v.custom_field_id === 'f-consumo')?.value).toBe(
      '1500',
    )
  })

  it('never overwrites an existing ciudad — the lead form already answered it', async () => {
    const field = { id: 'f-ciudad', account_id: 'acct-1', field_name: CIUDAD_FIELD_NAME }
    const { db, values } = fakeDb({
      fields: [field],
      values: [
        { contact_id: 'contact-1', custom_field_id: 'f-ciudad', value: 'Tulum' },
      ],
    })
    await saveReceiptData(db, {
      ...ARGS,
      // The receipt was misread / belongs to a relative's house in a
      // different city — must not clobber the form's real answer.
      extraction: extraction({ ciudad: 'Cancún' }),
    })
    expect(values.find((v) => v.custom_field_id === 'f-ciudad')?.value).toBe(
      'Tulum',
    )
  })

  it('fills ciudad when the contact has none yet', async () => {
    const field = { id: 'f-ciudad', account_id: 'acct-1', field_name: CIUDAD_FIELD_NAME }
    const { db, values } = fakeDb({ fields: [field], values: [] })
    await saveReceiptData(db, {
      ...ARGS,
      extraction: extraction({ ciudad: 'Playa del Carmen' }),
    })
    expect(values.find((v) => v.custom_field_id === 'f-ciudad')?.value).toBe(
      'Playa del Carmen',
    )
  })

  it('skips implausible averages, missing ciudad, and unmapped tariffs', async () => {
    const { db, values } = fakeDb()
    await saveReceiptData(db, {
      ...ARGS,
      extraction: extraction({ promedio_bimestral_kwh: 3, tarifa: 'XYZ' }),
    })
    expect(values).toHaveLength(0)
  })
})
