import type { SupabaseClient } from '@supabase/supabase-js'
import { METERS_MARKER_INSTRUCTION, type ReceiptExtraction } from './receipt'

// ============================================================
// Properties split across several CFE meters.
//
// The reading pipeline was built around one bill: one vision call, one
// average, one tier, one PDF. A customer whose consumption is divided
// between two or three meters breaks every one of those assumptions in
// the same quiet way — each bill prices cleanly on its own, so the bot
// happily sent one proposal per meter, each sized for a fraction of the
// house.
//
// This module is the gate in front of the quote. It accumulates the
// bills a customer sends across turns, decides whether what it holds is
// the whole property yet, and only then hands the pricing layer a
// single combined reading. Everything downstream — `resolveQuote`,
// `buildFinancials`, `sendQuoteProposal` — keeps working on one reading
// and never learns there were several meters.
//
// Two independent signals close the gate, and they cover each other:
//   - the customer states a count ("tengo tres medidores"), which the
//     model reports as a `[MEDIDORES: N]` marker; or
//   - the bot detects a second distinct bill and asks outright.
// ============================================================

/** Conversation-scoped accumulation of one customer's meters. */
export interface MeterState {
  /**
   * How many meters the customer said they have, via the
   * `[MEDIDORES: N]` marker. Null until they say so.
   */
  expected: number | null
  /** Bills gathered so far, one per distinct meter, oldest first. */
  readings: ReceiptExtraction[]
  /**
   * Media already extracted. Kept so a burst that re-reports an old
   * receipt costs nothing: a second vision call on one bill is spend we
   * already made, and two reads are not obliged to agree.
   */
  readMediaIds: string[]
  /**
   * Consecutive asks that produced nothing new — not asks in total.
   * A customer who answers by sending the next bill resets it, so the
   * bound below only fires on a conversation that has actually stalled,
   * never on one that is simply taking a few messages to get there.
   */
  askedCount: number
  /** ISO timestamp of the newest bill added. Drives batch expiry. */
  updatedAt: string
}

/**
 * How long a batch of meters stays open. A customer who sends one bill
 * today and another next month is quoting a different project, not
 * completing this one — summing across that gap would invent a house
 * twice the size of either.
 */
const BATCH_TTL_MS = 24 * 60 * 60_000

/** Asks before the thread goes to a human. Two is enough to cover a
 *  customer who missed the question once; a third is a conversation
 *  that isn't working and needs a person. */
const MAX_ASKS = 2

/** Meters one batch will track. Past this the project is commercial
 *  enough to deserve a bespoke design and a human. */
const MAX_METERS = 4

export function emptyMeterState(): MeterState {
  return {
    expected: null,
    readings: [],
    readMediaIds: [],
    askedCount: 0,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Whether two readings describe the same physical meter.
 *
 * The service number is the only real identity a CFE bill carries, so
 * when both sides have one the answer is exact. When they don't, the
 * fallback compares the bill's own contents and demands two independent
 * matches out of three, because the cost of each mistake is not
 * symmetric: calling one bill two meters makes the bot ask a customer
 * to confirm meters they don't have (annoying, and they can correct
 * it), while calling two meters one bill silently quotes half a house.
 * Two matching fields is beyond coincidence for separate meters and
 * still forgiving of an OCR that drops a single figure.
 */
export function sameMeter(a: ReceiptExtraction, b: ReceiptExtraction): boolean {
  if (a.numero_servicio && b.numero_servicio) {
    return a.numero_servicio === b.numero_servicio
  }
  const matches = [
    a.periodo_actual != null && a.periodo_actual === b.periodo_actual,
    a.consumo_periodo_actual_kwh != null &&
      a.consumo_periodo_actual_kwh === b.consumo_periodo_actual_kwh,
    a.costo_periodo_mxn != null && a.costo_periodo_mxn === b.costo_periodo_mxn,
  ].filter(Boolean).length
  return matches >= 2
}

/** Sum of the non-null values, or null when there is nothing to add. */
function sumOrNull(values: readonly (number | null)[]): number | null {
  const present = values.filter(
    (v): v is number => v != null && Number.isFinite(v),
  )
  return present.length > 0 ? present.reduce((sum, v) => sum + v, 0) : null
}

/**
 * Element-wise sum of per-period arrays, truncated to the shortest.
 *
 * Index i means "the same bimester" across meters, so alignment is the
 * whole point — and a meter that only reported three history rows
 * cannot contribute to a fourth. Truncating keeps every summed period a
 * true whole-property figure; carrying the longer array forward would
 * mix "both meters" periods with "one meter" periods in a single
 * series, which is exactly the shape the anomaly check reads as an
 * empty house.
 */
function sumByPeriod(series: readonly (readonly number[])[]): number[] {
  if (series.length === 0) return []
  const length = Math.min(...series.map((s) => s.length))
  return Array.from({ length }, (_, i) =>
    series.reduce((sum, s) => sum + s[i], 0),
  )
}

/** Same, for the history's money column, where a null means "that row
 *  was unreadable". A null on any meter makes the whole-property figure
 *  unknowable for that bimester, so it stays null and `projectionBaseCost`
 *  skips it — better a shorter average than a total missing a meter. */
function sumByPeriodNullable(
  series: readonly (readonly (number | null)[])[],
): (number | null)[] {
  if (series.length === 0) return []
  const length = Math.min(...series.map((s) => s.length))
  return Array.from({ length }, (_, i) => {
    const values = series.map((s) => s[i])
    return values.some((v) => v == null || !Number.isFinite(v))
      ? null
      : values.reduce((sum: number, v) => sum + (v as number), 0)
  })
}

/**
 * Fold several meters' bills into the single reading the pricing layer
 * expects — the whole property's consumption and the whole property's
 * electricity bill.
 *
 * A one-element list is returned untouched, so the single-meter path
 * that serves almost every customer runs byte-identical code to before
 * this module existed.
 */
export function combineReadings(
  readings: readonly ReceiptExtraction[],
): ReceiptExtraction {
  if (readings.length === 1) return readings[0]

  const first = <T>(pick: (r: ReceiptExtraction) => T | null): T | null =>
    readings.map(pick).find((v) => v != null) ?? null

  const advertencias = [
    ...new Set(readings.map((r) => r.advertencias).filter(Boolean)),
  ].join('; ')

  return {
    consumo_periodo_actual_kwh: sumOrNull(
      readings.map((r) => r.consumo_periodo_actual_kwh),
    ),
    periodo_actual: first((r) => r.periodo_actual),
    historial_bimestres_kwh: sumByPeriod(
      readings.map((r) => r.historial_bimestres_kwh),
    ),
    // The weakest meter governs: an average is only as trustworthy as
    // the thinnest evidence behind any part of it.
    cantidad_periodos_usados: Math.min(
      ...readings.map((r) => r.cantidad_periodos_usados),
    ),
    promedio_bimestral_kwh: sumOrNull(
      readings.map((r) => r.promedio_bimestral_kwh),
    ),
    incluye_periodo_actual: readings.every((r) => r.incluye_periodo_actual),
    periodos_promediados_kwh: sumByPeriod(
      readings.map((r) => r.periodos_promediados_kwh),
    ),
    tarifa: first((r) => r.tarifa),
    // A sum has no service number of its own, and inventing one would
    // make the combined reading look like a bill that could be matched
    // against a real meter.
    numero_servicio: null,
    ciudad: first((r) => r.ciudad),
    importe_periodo_mxn: sumOrNull(readings.map((r) => r.importe_periodo_mxn)),
    importe_dap_mxn: sumOrNull(readings.map((r) => r.importe_dap_mxn)),
    importe_total_a_pagar_mxn: sumOrNull(
      readings.map((r) => r.importe_total_a_pagar_mxn),
    ),
    historial_bimestres_importe_mxn: sumByPeriodNullable(
      readings.map((r) => r.historial_bimestres_importe_mxn),
    ),
    costo_periodo_mxn: sumOrNull(readings.map((r) => r.costo_periodo_mxn)),
    advertencias,
  }
}

/**
 * Merge freshly-read bills into the state, replacing any that turn out
 * to be a meter already held.
 *
 * Bills read in one turn are distinct documents by construction, so
 * they are never deduped against each other — only against what was
 * stored on earlier turns. A repeat of a known meter replaces the old
 * reading rather than adding to it: the newer photo is usually the
 * clearer one, and it is the reason the customer sent it again.
 */
export function mergeReadings(
  state: MeterState,
  incoming: readonly ReceiptExtraction[],
  mediaIds: readonly string[] = [],
): MeterState {
  const readings = [...state.readings]
  for (const reading of incoming) {
    const existing = readings.findIndex((r) => sameMeter(r, reading))
    if (existing >= 0) readings[existing] = reading
    else if (readings.length < MAX_METERS) readings.push(reading)
  }
  return {
    ...state,
    readings,
    readMediaIds: [...new Set([...state.readMediaIds, ...mediaIds])],
    // A bill arriving IS the answer to "how many do you have?", even
    // when the customer never says a number. Resetting here is what
    // keeps the ask bound measuring a stalled conversation rather than
    // a slow one — otherwise a customer who sends their meters one
    // message at a time gets handed to a human for cooperating.
    askedCount: incoming.length > 0 ? 0 : state.askedCount,
    updatedAt: new Date().toISOString(),
  }
}

/** What this turn may do with the bills gathered so far. */
export type MeterGate =
  /** The property is fully covered — price `reading`, send the PDF. */
  | { kind: 'ready'; reading: ReceiptExtraction; count: number }
  /** The customer named a count we haven't reached. Ask for the rest. */
  | {
      kind: 'awaiting_more'
      reading: ReceiptExtraction
      count: number
      expected: number
    }
  /** Distinct meters arrived with no count stated. Ask whether that's all. */
  | { kind: 'awaiting_confirmation'; reading: ReceiptExtraction; count: number }
  /** Asked and asked and got no usable answer — a person takes it. */
  | { kind: 'handoff'; count: number }

/**
 * Decide what the bot may do with the meters it holds.
 *
 * The single-bill case — one reading, nothing said about meters — falls
 * straight through to `ready`, so the customer who sends one receipt
 * sees exactly the behaviour they saw before any of this existed. Every
 * other branch exists because quoting would be wrong, not because the
 * reading is bad.
 */
export function resolveMeterGate(state: MeterState): MeterGate {
  const count = state.readings.length
  if (count === 0) return { kind: 'handoff', count }

  const reading = combineReadings(state.readings)

  if (state.expected != null) {
    if (count >= state.expected) return { kind: 'ready', reading, count }
    // A customer who states a count and then stops sending is a
    // conversation a person should finish, not one the bot re-asks
    // forever.
    if (state.askedCount >= MAX_ASKS) return { kind: 'handoff', count }
    return { kind: 'awaiting_more', reading, count, expected: state.expected }
  }

  // Nothing stated. One bill is the ordinary customer; several distinct
  // bills is the case this module exists for, and the only honest move
  // is to ask whether that is all of them.
  if (count <= 1) return { kind: 'ready', reading, count }
  if (state.askedCount >= MAX_ASKS) return { kind: 'handoff', count }
  return { kind: 'awaiting_confirmation', reading, count }
}

/**
 * The note for a turn that carries no new receipt while a batch is
 * still open — the turn where the customer answers "sí, son esos tres"
 * in plain text.
 *
 * Without this the marker instruction would only ever reach the model
 * on turns that happen to include an image, which is precisely not the
 * turn the answer arrives on: the bot asks, the customer replies with
 * words, and the count would fall on the floor while the batch waited
 * for bills nobody was going to send.
 *
 * Returns null when there is nothing pending, so an ordinary
 * conversation never sees it.
 */
export function formatMeterGateNote(state: MeterState): string | null {
  const gate = resolveMeterGate(state)
  if (gate.kind === 'ready' || gate.kind === 'handoff') return null

  const lines = [
    '[NOTA DEL SISTEMA — cotización en pausa por medidores múltiples.',
    `recibos_recibidos: ${gate.count}`,
  ]
  if (gate.kind === 'awaiting_more') {
    lines.push(
      `medidores_declarados: ${gate.expected}; faltan ${Math.max(gate.expected - gate.count, 0)} recibo(s).`,
      'Si el cliente todavía no los manda, pídeselos con amabilidad. NO des precio ni cotización hasta tenerlos todos.',
    )
  } else {
    lines.push(
      'El cliente aún no ha dicho cuántos medidores tiene en total. Pregúntaselo si no lo ha respondido. NO des precio ni cotización hasta saberlo.',
    )
  }
  lines.push(
    METERS_MARKER_INSTRUCTION,
    'Responde al cliente con naturalidad — nunca menciones esta nota ni muestres JSON.]',
  )
  return lines.join('\n')
}

/**
 * Rebuild a batch from the `conversations.ai_meter_state` column.
 *
 * Takes the raw column rather than querying, because the auto-reply
 * dispatcher already selects the conversation row on its way past the
 * eligibility gates — a second round trip to read one more column of a
 * row we are holding would be latency on the customer's reply.
 *
 * Total on its input: anything unrecognised, malformed, or past its TTL
 * yields a fresh batch, so a bad write degrades to single-meter
 * behaviour — the behaviour that already served every customer before
 * this module existed.
 */
export function parseMeterState(raw: unknown): MeterState {
  if (!raw || typeof raw !== 'object') return emptyMeterState()
  const s = raw as Partial<MeterState>
  if (!Array.isArray(s.readings) || s.readings.length === 0) {
    return emptyMeterState()
  }

  const updatedAt =
    typeof s.updatedAt === 'string' ? s.updatedAt : new Date(0).toISOString()
  const age = Date.now() - new Date(updatedAt).getTime()
  if (!Number.isFinite(age) || age > BATCH_TTL_MS) return emptyMeterState()

  return {
    expected:
      typeof s.expected === 'number' && s.expected > 0 ? s.expected : null,
    readings: s.readings as ReceiptExtraction[],
    readMediaIds: Array.isArray(s.readMediaIds) ? s.readMediaIds : [],
    askedCount: typeof s.askedCount === 'number' ? s.askedCount : 0,
    updatedAt,
  }
}

/** Persist the batch. Never throws — losing the batch costs a repeated
 *  question, not the customer's reply. */
export async function saveMeterState(
  db: SupabaseClient,
  conversationId: string,
  state: MeterState,
): Promise<void> {
  try {
    const { error } = await db
      .from('conversations')
      .update({ ai_meter_state: state })
      .eq('id', conversationId)
    if (error) throw error
  } catch (err) {
    console.error('[ai meters] failed to save meter state:', err)
  }
}

/**
 * Drop the batch once its quote has gone out, so the customer's next
 * receipt starts a new project instead of being summed onto a house
 * that was already quoted.
 */
export async function clearMeterState(
  db: SupabaseClient,
  conversationId: string,
): Promise<void> {
  try {
    await db
      .from('conversations')
      .update({ ai_meter_state: null })
      .eq('id', conversationId)
  } catch (err) {
    console.error('[ai meters] failed to clear meter state:', err)
  }
}
