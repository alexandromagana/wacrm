import { describe, it, expect } from 'vitest'
import {
  applyMeterConfirmation,
  combineReadings,
  emptyMeterState,
  isMeterConfirmation,
  formatMeterGateNote,
  mergeReadings,
  parseMeterState,
  resolveMeterGate,
  sameMeter,
  type MeterState,
} from './meters'
import type { ReceiptExtraction } from './receipt'

function bill(overrides: Partial<ReceiptExtraction> = {}): ReceiptExtraction {
  return {
    consumo_periodo_actual_kwh: 1000,
    periodo_actual: '22 MAY 26 - 22 JUL 26',
    historial_bimestres_kwh: [900, 950, 1000, 1050, 1100],
    historial_bimestres_periodo: [null, null, null, null, null],
    cantidad_periodos_usados: 6,
    promedio_bimestral_kwh: 1000,
    incluye_periodo_actual: true,
    periodos_promediados_kwh: [1000, 900, 950, 1000, 1050, 1100],
    tarifa: '1D',
    numero_servicio: '782990401509',
    ciudad: 'CANCUN',
    importe_periodo_mxn: 4000,
    importe_dap_mxn: 100,
    importe_total_a_pagar_mxn: 4100,
    historial_bimestres_importe_mxn: [3600, 3800, 4000, 4200, 4400],
    costo_periodo_mxn: 4100,
    advertencias: '',
    ...overrides,
  }
}

function stateWith(
  readings: ReceiptExtraction[],
  overrides: Partial<MeterState> = {},
): MeterState {
  return { ...emptyMeterState(), readings, ...overrides }
}

describe('sameMeter', () => {
  it('matches on the service number, whatever else differs', () => {
    // The same bill read twice: OCR disagreed about the consumption,
    // but the meter it belongs to is not in doubt.
    const first = bill({ numero_servicio: '782990401509' })
    const second = bill({
      numero_servicio: '782990401509',
      consumo_periodo_actual_kwh: 1004,
      periodo_actual: null,
    })
    expect(sameMeter(first, second)).toBe(true)
  })

  it('separates two meters that both read their service number', () => {
    expect(
      sameMeter(
        bill({ numero_servicio: '782990401509' }),
        bill({ numero_servicio: '782250505386' }),
      ),
    ).toBe(false)
  })

  it('falls back to bill contents when a service number is missing', () => {
    // Period + consumption agreeing is not a coincidence across meters.
    const scanned = bill({ numero_servicio: null })
    expect(sameMeter(bill(), scanned)).toBe(true)
  })

  it('calls it a second meter when the contents genuinely differ', () => {
    const other = bill({
      numero_servicio: null,
      periodo_actual: '20 ABR 26 - 20 JUN 26',
      consumo_periodo_actual_kwh: 430,
      costo_periodo_mxn: 1800,
    })
    expect(sameMeter(bill(), other)).toBe(false)
  })

  it('needs two matching fields, not one, before merging blind', () => {
    // Same billing period is ordinary across meters on one property —
    // they are read the same week. On its own it must not merge them.
    const sibling = bill({
      numero_servicio: null,
      consumo_periodo_actual_kwh: 640,
      costo_periodo_mxn: 2600,
    })
    expect(sameMeter(bill(), sibling)).toBe(false)
  })
})

describe('combineReadings', () => {
  it('returns a lone reading untouched', () => {
    const only = bill()
    expect(combineReadings([only])).toBe(only)
  })

  it('sums consumption and cost across meters', () => {
    const combined = combineReadings([
      bill({ promedio_bimestral_kwh: 1000, costo_periodo_mxn: 4100 }),
      bill({
        numero_servicio: '782250505386',
        promedio_bimestral_kwh: 700,
        costo_periodo_mxn: 2900,
      }),
    ])
    expect(combined.promedio_bimestral_kwh).toBe(1700)
    expect(combined.costo_periodo_mxn).toBe(7000)
  })

  it('adds the history bimester by bimester', () => {
    const combined = combineReadings([
      bill({ historial_bimestres_kwh: [100, 200, 300] }),
      bill({
        numero_servicio: '2',
        historial_bimestres_kwh: [10, 20, 30],
      }),
    ])
    expect(combined.historial_bimestres_kwh).toEqual([110, 220, 330])
  })

  it('truncates to the shortest history rather than mixing coverage', () => {
    // Bimester 4 exists on one meter only. Carrying it forward would
    // put a one-meter period in a two-meter series, which reads as a
    // sudden drop — the exact shape the anomaly check treats as an
    // empty house.
    const combined = combineReadings([
      bill({ historial_bimestres_kwh: [100, 200, 300, 400] }),
      bill({ numero_servicio: '2', historial_bimestres_kwh: [10, 20, 30] }),
    ])
    expect(combined.historial_bimestres_kwh).toEqual([110, 220, 330])
  })

  it('nulls a money bimester when any meter could not read it', () => {
    const combined = combineReadings([
      bill({ historial_bimestres_importe_mxn: [100, 200, 300] }),
      bill({
        numero_servicio: '2',
        historial_bimestres_importe_mxn: [10, null, 30],
      }),
    ])
    expect(combined.historial_bimestres_importe_mxn).toEqual([110, null, 330])
  })

  it('takes the weakest meter’s period count', () => {
    const combined = combineReadings([
      bill({ cantidad_periodos_usados: 6 }),
      bill({ numero_servicio: '2', cantidad_periodos_usados: 2 }),
    ])
    expect(combined.cantidad_periodos_usados).toBe(2)
  })

  it('only claims the current period when every meter has it', () => {
    const combined = combineReadings([
      bill({ incluye_periodo_actual: true }),
      bill({ numero_servicio: '2', incluye_periodo_actual: false }),
    ])
    expect(combined.incluye_periodo_actual).toBe(false)
  })

  it('carries no service number of its own', () => {
    const combined = combineReadings([bill(), bill({ numero_servicio: '2' })])
    expect(combined.numero_servicio).toBeNull()
  })

  it('keeps the first city and tariff it finds', () => {
    const combined = combineReadings([
      bill({ ciudad: null, tarifa: null }),
      bill({ numero_servicio: '2', ciudad: 'TULUM', tarifa: 'PDBT' }),
    ])
    expect(combined.ciudad).toBe('TULUM')
    expect(combined.tarifa).toBe('PDBT')
  })

  it('de-duplicates warnings instead of repeating one per meter', () => {
    const combined = combineReadings([
      bill({ advertencias: 'foto borrosa' }),
      bill({ numero_servicio: '2', advertencias: 'foto borrosa' }),
    ])
    expect(combined.advertencias).toBe('foto borrosa')
  })
})

describe('mergeReadings', () => {
  it('adds a genuinely new meter', () => {
    const state = mergeReadings(stateWith([bill()]), [
      bill({ numero_servicio: '782250505386' }),
    ])
    expect(state.readings).toHaveLength(2)
  })

  it('replaces a meter already held rather than double-counting it', () => {
    // The customer re-sent a clearer photo of the bill we already have.
    const state = mergeReadings(stateWith([bill()]), [
      bill({ consumo_periodo_actual_kwh: 1010 }),
    ])
    expect(state.readings).toHaveLength(1)
    expect(state.readings[0].consumo_periodo_actual_kwh).toBe(1010)
  })

  it('records the media it read, without duplicates', () => {
    const first = mergeReadings(emptyMeterState(), [bill()], ['m1'])
    const second = mergeReadings(first, [bill()], ['m1', 'm2'])
    expect(second.readMediaIds).toEqual(['m1', 'm2'])
  })

  it('resets the ask bound when a new bill arrives', () => {
    // The customer answered by sending the next meter. That is
    // progress, not the silence the bound is there to catch.
    const state = mergeReadings(
      stateWith([bill()], { askedCount: 2 }),
      [bill({ numero_servicio: '782250505386' })],
    )
    expect(state.askedCount).toBe(0)
  })

  it('leaves the ask bound alone when nothing new came in', () => {
    const state = mergeReadings(stateWith([bill()], { askedCount: 1 }), [])
    expect(state.askedCount).toBe(1)
  })

  it('stops accumulating past the meter ceiling', () => {
    let state = emptyMeterState()
    for (let i = 0; i < 8; i++) {
      state = mergeReadings(state, [bill({ numero_servicio: `78299040150${i}` })])
    }
    expect(state.readings).toHaveLength(4)
  })
})

describe('resolveMeterGate', () => {
  it('quotes a single bill immediately — the ordinary customer', () => {
    const gate = resolveMeterGate(stateWith([bill()]))
    expect(gate.kind).toBe('ready')
  })

  it('holds the quote when a second distinct meter shows up unannounced', () => {
    const gate = resolveMeterGate(
      stateWith([bill(), bill({ numero_servicio: '782250505386' })]),
    )
    expect(gate.kind).toBe('awaiting_confirmation')
  })

  it('waits for the bills a stated count still owes', () => {
    const gate = resolveMeterGate(
      stateWith([bill(), bill({ numero_servicio: '2' })], { expected: 3 }),
    )
    expect(gate).toMatchObject({ kind: 'awaiting_more', expected: 3, count: 2 })
  })

  it('quotes the sum once the stated count is met', () => {
    const gate = resolveMeterGate(
      stateWith([bill(), bill({ numero_servicio: '2' })], { expected: 2 }),
    )
    expect(gate.kind).toBe('ready')
    if (gate.kind !== 'ready') throw new Error('unreachable')
    expect(gate.reading.promedio_bimestral_kwh).toBe(2000)
    expect(gate.count).toBe(2)
  })

  it('quotes a confirmed single meter even after the question was asked', () => {
    // "[MEDIDORES: 1]" — the customer said the one bill is all there is.
    const gate = resolveMeterGate(stateWith([bill()], { expected: 1 }))
    expect(gate.kind).toBe('ready')
  })

  it('hands off rather than asking a third time', () => {
    const gate = resolveMeterGate(
      stateWith([bill(), bill({ numero_servicio: '2' })], { askedCount: 2 }),
    )
    expect(gate.kind).toBe('handoff')
  })

  it('hands off when a stated count never arrives', () => {
    const gate = resolveMeterGate(
      stateWith([bill()], { expected: 3, askedCount: 2 }),
    )
    expect(gate.kind).toBe('handoff')
  })
})

describe('isMeterConfirmation', () => {
  it.each([
    'sí',
    'Sí',
    'si',
    'Sí, son todos',
    'sí son todos mis medidores',
    'Así es',
    'asi es, esos son todos',
    'correcto',
    'Correcto ✅',
    'exacto',
    'exactamente',
    'efectivamente',
    'confirmo',
    'Son todos',
    'esos son todos los que tengo',
    'es todo',
    'ya están todos',
    'solo esos',
    'únicamente esos',
    'sí, son todos. gracias',
  ])('reads %j as a confirmation', (message) => {
    expect(isMeterConfirmation(message)).toBe(true)
  })

  it.each([
    // Plain refusals and corrections.
    'no',
    'no, tengo otro',
    'no son todos',
    'falta uno',
    'me falta un recibo',
    // A stated count is the marker's job, not this one — "tres" against
    // two bills in hand must never read as "those two are all of them".
    'sí, tengo tres',
    'si son 3 medidores',
    // "sí" attached to a request. The gate's question is not what this
    // answers, and closing on it would fire a PDF for half a house.
    'sí, mándame la cotización',
    'si me puedes dar el precio',
    'sí quiero',
    'si, cuánto sale?',
    // Deferrals — the customer is going to send more.
    'ahorita te mando el otro',
    'sí, espérame tantito',
    'sí, déjame buscar el segundo',
    // Hedges.
    'creo que sí',
    'no estoy seguro',
    // Not an answer at all.
    'gracias',
    'buenos días',
    '[Imagen adjunta]',
    '',
    '   ',
  ])('leaves %j unresolved', (message) => {
    expect(isMeterConfirmation(message)).toBe(false)
  })

  it('treats a null or absent message as no answer', () => {
    expect(isMeterConfirmation(null)).toBe(false)
    expect(isMeterConfirmation(undefined)).toBe(false)
  })

  it('stops at a sentence, however agreeable its words', () => {
    // Every word is in the vocabulary; the length is not an answer.
    expect(
      isMeterConfirmation(
        'si es que son todos los medidores recibos que tengo ya',
      ),
    ).toBe(false)
  })
})

describe('applyMeterConfirmation', () => {
  const two = () => [bill(), bill({ numero_servicio: '782250505386' })]

  it('closes the gate on a plain "sí" once the question has been asked', () => {
    const state = applyMeterConfirmation(
      stateWith(two(), { askedCount: 1 }),
      'sí, son todos',
    )
    expect(state.expected).toBe(2)
    expect(resolveMeterGate(state).kind).toBe('ready')
  })

  it('rescues the customer the ask bound was about to escalate', () => {
    // The exact bug: the model dropped the marker twice, `askedCount`
    // reached its bound, and the answer sitting in front of the gate
    // was never read.
    const stalled = stateWith(two(), { askedCount: 2 })
    expect(resolveMeterGate(stalled).kind).toBe('handoff')
    expect(
      resolveMeterGate(applyMeterConfirmation(stalled, 'así es')).kind,
    ).toBe('ready')
  })

  it('quotes the sum of the confirmed meters, not one of them', () => {
    const gate = resolveMeterGate(
      applyMeterConfirmation(stateWith(two(), { askedCount: 1 }), 'correcto'),
    )
    expect(gate).toMatchObject({ kind: 'ready', count: 2 })
    if (gate.kind !== 'ready') throw new Error('unreachable')
    expect(gate.reading.promedio_bimestral_kwh).toBe(2000)
  })

  it('ignores a "sí" when nothing has been asked yet', () => {
    // Two bills just landed in one burst; the gate has not put its
    // question yet, so this "sí" belongs to some other exchange.
    const state = stateWith(two(), { askedCount: 0 })
    expect(applyMeterConfirmation(state, 'sí')).toBe(state)
    expect(resolveMeterGate(applyMeterConfirmation(state, 'sí')).kind).toBe(
      'awaiting_confirmation',
    )
  })

  it('never closes a batch that still owes bills against a stated count', () => {
    // "sí" here answers something else entirely — the customer said
    // three meters and has sent two. Only the third bill settles this.
    const state = stateWith(two(), { expected: 3, askedCount: 2 })
    expect(applyMeterConfirmation(state, 'sí, son todos')).toBe(state)
    expect(resolveMeterGate(state).kind).toBe('handoff')
  })

  it('leaves a single-bill batch alone', () => {
    // Nothing is gated, so there is nothing for a "sí" to close — and
    // inventing an `expected` here would be a count nobody stated.
    const state = stateWith([bill()], { askedCount: 1 })
    expect(applyMeterConfirmation(state, 'sí')).toBe(state)
  })

  it('leaves an ambiguous reply unresolved rather than guessing', () => {
    const state = stateWith(two(), { askedCount: 1 })
    expect(applyMeterConfirmation(state, 'sí, mándame la cotización')).toBe(
      state,
    )
    expect(
      resolveMeterGate(applyMeterConfirmation(state, 'no, falta uno')).kind,
    ).toBe('awaiting_confirmation')
  })

  it('does not let a confirmation ride in on the turn a bill arrives', () => {
    // `mergeReadings` zeroes the ask bound when a receipt lands, so the
    // turn that brings a new meter can never also declare them all in —
    // there may well be a fourth bill behind the third.
    const merged = mergeReadings(stateWith(two(), { askedCount: 2 }), [
      bill({ numero_servicio: '782250505999' }),
    ])
    expect(applyMeterConfirmation(merged, 'sí, son todos')).toBe(merged)
  })
})

describe('parseMeterState', () => {
  it('treats null and junk as no batch', () => {
    expect(parseMeterState(null).readings).toEqual([])
    expect(parseMeterState('nonsense').readings).toEqual([])
    expect(parseMeterState({ readings: 'not-an-array' }).readings).toEqual([])
  })

  it('round-trips a live batch', () => {
    const saved = stateWith([bill()], { expected: 2, askedCount: 1 })
    const parsed = parseMeterState(JSON.parse(JSON.stringify(saved)))
    expect(parsed.expected).toBe(2)
    expect(parsed.askedCount).toBe(1)
    expect(parsed.readings).toHaveLength(1)
  })

  it('drops a batch older than its TTL', () => {
    // A receipt from last month is a different project, not the missing
    // half of this one.
    const stale = stateWith([bill()], {
      updatedAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
    })
    expect(parseMeterState(stale).readings).toEqual([])
  })

  it('ignores a nonsense expected count', () => {
    expect(parseMeterState(stateWith([bill()], { expected: 0 })).expected).toBeNull()
  })
})

describe('formatMeterGateNote', () => {
  it('says nothing when the batch is settled', () => {
    expect(formatMeterGateNote(stateWith([bill()]))).toBeNull()
  })

  it('carries the marker instruction so a spoken answer can land', () => {
    const note = formatMeterGateNote(
      stateWith([bill(), bill({ numero_servicio: '2' })]),
    )
    expect(note).toContain('MEDIDORES')
    expect(note).toMatch(/NO des precio/i)
  })

  it('names how many bills are still owed', () => {
    const note = formatMeterGateNote(
      stateWith([bill()], { expected: 3 }),
    )
    expect(note).toContain('faltan 2')
  })

  it('carries the figures the proposal will print once the count is confirmed', () => {
    // The confirmation turn brings no bill, so without these the model
    // is asked to unlock a quote while holding no number it may state —
    // and a model told never to invent prices escalates instead.
    const note = formatMeterGateNote(
      stateWith([bill(), bill({ numero_servicio: '2' })]),
    )
    expect(note).toContain('proyeccion_si_confirma_que_son_todos')
    expect(note).toMatch(/no las digas mientras el cliente no confirme/i)
  })

  it('withholds figures while bills are still missing', () => {
    // A stated count with bills outstanding prices only part of the
    // property; those numbers are wrong, not merely early.
    const note = formatMeterGateNote(stateWith([bill()], { expected: 3 }))
    expect(note).not.toContain('proyeccion_si_confirma_que_son_todos')
  })
})
