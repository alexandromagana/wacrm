import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildExtraction,
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
  const base: ReceiptExtraction = {
    consumo_periodo_actual_kwh: null,
    periodo_actual: null,
    historial_bimestres_kwh: [],
    cantidad_periodos_usados: 0,
    promedio_bimestral_kwh: null,
    incluye_periodo_actual: false,
    periodos_promediados_kwh: [],
    tarifa: null,
    numero_servicio: null,
    ciudad: null,
    importe_periodo_mxn: null,
    importe_dap_mxn: null,
    importe_total_a_pagar_mxn: null,
    historial_bimestres_importe_mxn: [],
    costo_periodo_mxn: null,
    advertencias: '',
    ...overrides,
  }
  // Derived unless a test states them outright, so a fixture cannot
  // claim a current period in one field and deny it in another — the
  // review gate keys off exactly that disagreement.
  return {
    ...base,
    incluye_periodo_actual:
      overrides.incluye_periodo_actual ??
      base.consumo_periodo_actual_kwh != null,
    periodos_promediados_kwh:
      overrides.periodos_promediados_kwh ??
      [
        base.consumo_periodo_actual_kwh,
        ...base.historial_bimestres_kwh,
      ].filter((v): v is number => v != null),
  }
}

describe('parseReceiptJson', () => {
  it('parses a clean extraction and computes the average itself', () => {
    const raw = JSON.stringify({
      consumo_periodo_actual_kwh: 1450,
      periodo_actual: '01 May 26 - 30 Jun 26',
      historial_bimestres_kwh: [1380, 1420, 1500, 1290, 1410],
      tarifa: '1',
      ciudad: 'Cancún',
      advertencias: '',
    })
    const r = parseReceiptJson(raw)
    expect(r).not.toBeNull()
    // (1450+1380+1420+1500+1290+1410) / 6 = 1408.33… → 1408. Computed
    // here, never trusted from a (now removed) model-reported field.
    expect(r!.promedio_bimestral_kwh).toBe(1408)
    expect(r!.cantidad_periodos_usados).toBe(6)
    expect(r!.historial_bimestres_kwh).toHaveLength(5)
    expect(r!.tarifa).toBe('1')
    expect(r!.ciudad).toBe('Cancún')
  })

  it('caps the historial at 5 bimestres even if the model returns more — never more than a year', () => {
    const raw = JSON.stringify({
      consumo_periodo_actual_kwh: 1000,
      // 7 values — a receipt whose chart shows more than 5 bars, or a
      // model that didn't follow the "only the 5 most recent" rule.
      historial_bimestres_kwh: [900, 950, 1000, 1050, 1100, 1150, 1200],
    })
    const r = parseReceiptJson(raw)!
    expect(r.historial_bimestres_kwh).toEqual([900, 950, 1000, 1050, 1100])
    expect(r.cantidad_periodos_usados).toBe(6) // actual + 5, hard ceiling
  })

  it('averages over whatever is legible when a period is missing', () => {
    const r = parseReceiptJson(
      '{"consumo_periodo_actual_kwh": null, "historial_bimestres_kwh": [1000, 1200, 1400]}',
    )!
    expect(r.promedio_bimestral_kwh).toBe(1200) // (1000+1200+1400)/3
    expect(r.cantidad_periodos_usados).toBe(3)
  })

  it('returns a null average when nothing legible was extracted', () => {
    const r = parseReceiptJson(
      '{"consumo_periodo_actual_kwh": null, "historial_bimestres_kwh": []}',
    )!
    expect(r.promedio_bimestral_kwh).toBeNull()
    expect(r.cantidad_periodos_usados).toBe(0)
  })

  it('tolerates code fences and prose around the JSON', () => {
    const raw =
      'Aquí está:\n```json\n{"historial_bimestres_kwh": [], "consumo_periodo_actual_kwh": 1200, "periodo_actual": null, "tarifa": null, "ciudad": null, "advertencias": "solo una página"}\n```'
    const r = parseReceiptJson(raw)
    expect(r).not.toBeNull()
    expect(r!.promedio_bimestral_kwh).toBe(1200)
    expect(r!.advertencias).toBe('solo una página')
  })

  it('rounds a fractional average (banker beware: .5 rounds up)', () => {
    const r = parseReceiptJson(
      '{"consumo_periodo_actual_kwh": 10, "historial_bimestres_kwh": [11]}',
    )
    expect(r!.promedio_bimestral_kwh).toBe(11) // (10+11)/2 = 10.5 → 11
  })

  it('records whether the current period made it into the average', () => {
    const conActual = parseReceiptJson(
      '{"consumo_periodo_actual_kwh": 2545, "historial_bimestres_kwh": [1126, 879]}',
    )!
    expect(conActual.incluye_periodo_actual).toBe(true)
    expect(conActual.periodos_promediados_kwh).toEqual([2545, 1126, 879])

    // Page 1 unreadable. The average still computes off history — the
    // flag is the only thing standing between that and a priced PDF.
    const sinActual = parseReceiptJson(
      '{"historial_bimestres_kwh": [1126, 879]}',
    )!
    expect(sinActual.incluye_periodo_actual).toBe(false)
    expect(sinActual.periodos_promediados_kwh).toEqual([1126, 879])
    expect(sinActual.advertencias).toContain('periodo actual')
  })

  it('averages exactly the six periods it reports', () => {
    // Fabiola's bill. The arithmetic here is the whole quote: 7,318 / 6
    // = 1,220 kWh, which is the 8-panel tier.
    const r = parseReceiptJson(
      '{"consumo_periodo_actual_kwh": 2545, "historial_bimestres_kwh": [1126, 879, 1067, 1485, 216]}',
    )!
    expect(r.periodos_promediados_kwh).toHaveLength(6)
    expect(r.cantidad_periodos_usados).toBe(6)
    expect(r.promedio_bimestral_kwh).toBe(1220)
  })

  it('ignores a model-reported average entirely — always recomputes', () => {
    // Even if the model still emits these (legacy fields), they must
    // never leak through: the average is only ever derived from
    // consumo_periodo_actual_kwh + historial_bimestres_kwh.
    const r = parseReceiptJson(
      '{"consumo_periodo_actual_kwh": 1000, "historial_bimestres_kwh": [1000], "promedio_bimestral_kwh": 99999, "cantidad_periodos_usados": 42}',
    )!
    expect(r.promedio_bimestral_kwh).toBe(1000)
    expect(r.cantidad_periodos_usados).toBe(2)
  })

  it('filters non-numeric garbage out of historial instead of trusting it', () => {
    const r = parseReceiptJson(
      '{"historial_bimestres_kwh": [1380, "x", 1500], "advertencias": 42, "ciudad": 123}',
    )
    expect(r).not.toBeNull()
    expect(r!.historial_bimestres_kwh).toEqual([1380, 1500])
    expect(r!.promedio_bimestral_kwh).toBe(1440) // (1380+1500)/2
    // `advertencias: 42` is not a string and must not leak through. The
    // text that IS here is the one parseReceiptJson raises on its own:
    // this payload carries no current period.
    expect(r!.advertencias).not.toContain('42')
    expect(r!.advertencias).toContain('periodo actual')
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

  it('matches the hand-computed average on a real CFE bill', () => {
    // Regression guard, from a live misread: the model reported the
    // page-1 METER READING (lectura actual 1922) instead of the
    // period consumption (total del periodo 728), which inflated the
    // average to 1411 and produced a wrong quote. With the correct
    // page-1 figure the six periods must average 1212.
    const r = parseReceiptJson(
      JSON.stringify({
        consumo_periodo_actual_kwh: 728,
        periodo_actual: '12 ENE 26 - 10 MAR 26',
        historial_bimestres_kwh: [946, 1202, 1270, 1701, 1422],
        tarifa: '1',
        ciudad: 'Cancún',
        advertencias: '',
      }),
    )!
    expect(r.cantidad_periodos_usados).toBe(6) // 1 actual + 5 previos
    expect(r.promedio_bimestral_kwh).toBe(1212)

    // And the shape of the bug itself: a meter reading in that slot
    // lands on the wrong number the customer actually saw.
    const misread = parseReceiptJson(
      JSON.stringify({
        consumo_periodo_actual_kwh: 1922,
        historial_bimestres_kwh: [946, 1202, 1270, 1701, 1422],
      }),
    )!
    expect(misread.promedio_bimestral_kwh).toBe(1411)
  })
})

describe('parseReceiptJson — importes en pesos', () => {
  /** Osvaldo Coyac's real receipt, transcribed from the photos. */
  const OSVALDO = {
    consumo_periodo_actual_kwh: 2944,
    periodo_actual: '22 MAY 26 - 22 JUL 26',
    historial_bimestres_kwh: [2177, 1487, 1447, 1966, 2788],
    tarifa: '1D',
    ciudad: 'CANCUN, Q.R.',
    importe_periodo_mxn: 9814.27,
    importe_dap_mxn: 423.03,
    importe_total_a_pagar_mxn: 10237.85,
    historial_bimestres_importe_mxn: [6481, 5815, 5589, 7999, 9173],
    advertencias: '',
  }

  it('derives the period cost as charge + DAP, not the total to pay', () => {
    const r = parseReceiptJson(JSON.stringify(OSVALDO))!
    expect(r.costo_periodo_mxn).toBeCloseTo(10237.3, 2)
    expect(r.costo_periodo_mxn).not.toBe(r.importe_total_a_pagar_mxn)
    expect(r.promedio_bimestral_kwh).toBe(2135)
    expect(r.cantidad_periodos_usados).toBe(6)
  })

  it('stays quiet when the total matches the period within rounding', () => {
    // Here the adeudo (6,481.55) and the payment (-6,481.00) nearly
    // cancel, so the total lands $0.55 from the period cost.
    expect(parseReceiptJson(JSON.stringify(OSVALDO))!.advertencias).toBe('')
  })

  it('warns — but still uses the period — when the customer owes', () => {
    // Same bill, one bimester behind: the total carries the debt.
    const r = parseReceiptJson(
      JSON.stringify({
        ...OSVALDO,
        importe_total_a_pagar_mxn: 16718.85,
      }),
    )!
    expect(r.costo_periodo_mxn).toBeCloseTo(10237.3, 2)
    expect(r.advertencias).toMatch(/adeudo|saldo a favor/i)
  })

  it('keeps an existing warning and appends the mismatch', () => {
    const r = parseReceiptJson(
      JSON.stringify({
        ...OSVALDO,
        advertencias: 'la página 2 se ve borrosa',
        importe_total_a_pagar_mxn: 16718.85,
      }),
    )!
    expect(r.advertencias).toContain('la página 2 se ve borrosa')
    expect(r.advertencias).toMatch(/adeudo/i)
  })

  it('works without DAP, which not every receipt prints', () => {
    const r = parseReceiptJson(
      JSON.stringify({
        ...OSVALDO,
        importe_dap_mxn: null,
        importe_total_a_pagar_mxn: 9814.27,
      }),
    )!
    expect(r.importe_dap_mxn).toBeNull()
    expect(r.costo_periodo_mxn).toBeCloseTo(9814.27, 2)
    expect(r.advertencias).toBe('')
  })

  it('leaves the cost null when the period charge is unreadable', () => {
    // A total on its own is never enough — that is the whole trap.
    const r = parseReceiptJson(
      JSON.stringify({
        ...OSVALDO,
        importe_periodo_mxn: null,
        importe_dap_mxn: null,
      }),
    )!
    expect(r.costo_periodo_mxn).toBeNull()
    expect(r.importe_total_a_pagar_mxn).toBe(10237.85)
  })

  it('preserves the importe history slot-for-slot, nulls included', () => {
    const r = parseReceiptJson(
      JSON.stringify({
        ...OSVALDO,
        historial_bimestres_importe_mxn: [6481, null, 5589, 'ilegible', 9173],
      }),
    )!
    // The third kWh reading and the third importe must still describe
    // the same bimester — no compaction.
    expect(r.historial_bimestres_importe_mxn).toEqual([
      6481,
      null,
      5589,
      null,
      9173,
    ])
    expect(r.historial_bimestres_kwh).toHaveLength(5)
  })

  it('caps the importe history at five, like the kWh one', () => {
    const r = parseReceiptJson(
      JSON.stringify({
        ...OSVALDO,
        historial_bimestres_importe_mxn: [1, 2, 3, 4, 5, 6, 7, 8],
      }),
    )!
    expect(r.historial_bimestres_importe_mxn).toEqual([1, 2, 3, 4, 5])
  })

  it('defaults the money fields when the model omits them entirely', () => {
    const r = parseReceiptJson(
      JSON.stringify({
        consumo_periodo_actual_kwh: 1450,
        historial_bimestres_kwh: [1400],
      }),
    )!
    expect(r.importe_periodo_mxn).toBeNull()
    expect(r.costo_periodo_mxn).toBeNull()
    expect(r.historial_bimestres_importe_mxn).toEqual([])
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

describe('formatReceiptNote — the review gate', () => {
  // Fabiola's bill, the one that went wrong: 2,545 kWh this bimester on
  // top of a year that includes a 216 kWh period, when the house sat
  // empty. It prices at 8 panels and must not go out unasked.
  const vacancia = () =>
    extraction({
      consumo_periodo_actual_kwh: 2545,
      historial_bimestres_kwh: [1126, 879, 1067, 1485, 216],
      cantidad_periodos_usados: 6,
      promedio_bimestral_kwh: 1220,
      costo_periodo_mxn: 8304.21,
      tarifa: '1D',
    })

  it('orders the bot to ask, and not to quote, on an irregular history', () => {
    const note = formatReceiptNote(vacancia())
    expect(note).toContain('consumo_irregular')
    expect(note).toContain('216 kWh')
    expect(note).toContain('NO des precio')
    expect(note).toContain('desocupada')
  })

  it('withholds the projection the PDF would have carried', () => {
    // The savings lines exist to keep chat and document in agreement.
    // With no document going out, handing them over just invites the
    // bot to quote the numbers it was told not to quote.
    const note = formatReceiptNote(vacancia())
    expect(note).not.toContain('proyeccion_25_anios')
    expect(note).not.toContain('se_paga_solo_en')
  })

  it('tells the bot to answer the customer and re-ask, not to stonewall', () => {
    // Gregori replied to the question with a question of his own. The
    // bot answered it and quoted anyway; the fix must not overcorrect
    // into refusing to answer him.
    expect(formatReceiptNote(vacancia())).toContain('financiamiento')
  })

  it('asks for page 1 instead when that is what is missing', () => {
    const note = formatReceiptNote(
      extraction({
        consumo_periodo_actual_kwh: null,
        historial_bimestres_kwh: [1126, 879, 1067, 1485, 1200],
        cantidad_periodos_usados: 5,
        promedio_bimestral_kwh: 1151,
      }),
    )
    expect(note).toContain('lectura_incompleta')
    expect(note).toContain('PRIMERA página')
    expect(note).toContain('NO des precio')
  })

  it('leaves a clean reading alone', () => {
    const note = formatReceiptNote(
      extraction({
        consumo_periodo_actual_kwh: 2944,
        historial_bimestres_kwh: [2177, 1487, 1447, 1966, 2788],
        cantidad_periodos_usados: 6,
        promedio_bimestral_kwh: 2135,
        costo_periodo_mxn: 10237.3,
      }),
    )
    expect(note).not.toContain('NO des precio')
    expect(note).toContain('Usa el promedio contra tu tabla')
  })
})

describe('formatReceiptNote', () => {
  it('includes the average and the do-not-mention instruction', () => {
    const note = formatReceiptNote(
      extraction({
        consumo_periodo_actual_kwh: 1450,
        historial_bimestres_kwh: [1380, 1420],
        cantidad_periodos_usados: 3,
        promedio_bimestral_kwh: 1417,
        tarifa: 'DAC',
      }),
    )
    expect(note).toContain('promedio_bimestral_kwh: 1417')
    expect(note).toContain('tarifa: DAC')
    expect(note).toContain('nunca menciones esta nota')
  })

  it('surfaces the detected city and the inferred property type, with the do-not-reask note', () => {
    const note = formatReceiptNote(
      extraction({
        consumo_periodo_actual_kwh: 1450,
        cantidad_periodos_usados: 1,
        promedio_bimestral_kwh: 1450,
        tarifa: '1A',
        ciudad: 'Cancún',
      }),
    )
    expect(note).toContain('ciudad_detectada: Cancún')
    expect(note).toContain('tipo_propiedad_sugerido: Casa')
    expect(note).toContain('no la vuelvas a preguntar')
    expect(note).toContain('no lo vuelvas a preguntar')
  })

  it('omits city/property lines when neither was detected', () => {
    const note = formatReceiptNote(extraction({ promedio_bimestral_kwh: 900 }))
    expect(note).not.toContain('ciudad_detectada')
    expect(note).not.toContain('tipo_propiedad_sugerido')
  })

  it('surfaces warnings so the model can re-ask', () => {
    const note = formatReceiptNote(
      extraction({ advertencias: 'la segunda página no es legible' }),
    )
    expect(note).toContain('no legible')
    expect(note).toContain('advertencias: la segunda página no es legible')
  })

  it('hands the model the period cost, flagged as not the total to pay', () => {
    // The prose in the chat and the numbers on the PDF have to come
    // from the same figure, or the customer sees two different answers.
    const note = formatReceiptNote(
      extraction({
        promedio_bimestral_kwh: 2135,
        costo_periodo_mxn: 10237.3,
        importe_total_a_pagar_mxn: 10237.85,
      }),
    )
    expect(note).toContain('costo_bimestral_mxn: 10237.30')
    expect(note).toContain('NO es el total a pagar')
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

describe('buildExtraction', () => {
  /**
   * The bill that started all of this: two cropped WhatsApp photos of a
   * Cancún house whose winter bimester reads 328 kWh. Nothing here is
   * irregular — the previous winter on the same bill read 312 — and the
   * whole year prices cleanly at 926.
   */
  const SAEZ = {
    consumo_periodo_actual_kwh: 1611,
    historial_bimestres_kwh: [1220, 683, 328, 655, 1060],
    importe_periodo_mxn: 3634.31,
    importe_dap_mxn: 156.65,
    importe_total_a_pagar_mxn: 3791.2,
    tarifa: '1D',
    ciudad: 'Cancún',
  }

  it('averages the year the same way whoever supplied the numbers', () => {
    const fromModel = parseReceiptJson(JSON.stringify(SAEZ))!
    const byHand = buildExtraction(SAEZ)
    expect(byHand).toEqual(fromModel)
    expect(byHand.promedio_bimestral_kwh).toBe(926)
    expect(byHand.cantidad_periodos_usados).toBe(6)
    expect(byHand.incluye_periodo_actual).toBe(true)
    expect(byHand.periodos_promediados_kwh).toEqual([
      1611, 1220, 683, 328, 655, 1060,
    ])
  })

  it('derives the period cost from its parts, never the headline total', () => {
    // 3,791.20 is what the customer owes, debt included; 3,790.96 is
    // what this bimester of electricity cost. The 25-year projection
    // multiplies whichever one it is given.
    expect(buildExtraction(SAEZ).costo_periodo_mxn).toBeCloseTo(3790.96, 2)
  })

  it('says so out loud when the current period never made it in', () => {
    const r = buildExtraction({
      historial_bimestres_kwh: [1220, 683, 328],
    })
    expect(r.incluye_periodo_actual).toBe(false)
    expect(r.advertencias).toContain('no se pudo leer el consumo del periodo')
  })

  it('caps the history at a year however many values arrive', () => {
    const r = buildExtraction({
      consumo_periodo_actual_kwh: 900,
      historial_bimestres_kwh: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    })
    expect(r.historial_bimestres_kwh).toHaveLength(5)
    expect(r.cantidad_periodos_usados).toBe(6)
  })

  it('yields an unpriceable reading from nothing at all', () => {
    const r = buildExtraction({})
    expect(r.promedio_bimestral_kwh).toBeNull()
    expect(r.cantidad_periodos_usados).toBe(0)
    expect(r.costo_periodo_mxn).toBeNull()
  })
})
