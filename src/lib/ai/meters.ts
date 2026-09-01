import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildExtraction,
  METERS_MARKER_INSTRUCTION,
  MISSING_PAGE_ONE_WARNING,
  type QuoteHold,
  type ReceiptExtraction,
} from './receipt'
import { resolveQuote } from '@/lib/quotes/pricing'
import { buildFinancials, projectionBaseCost } from '@/lib/quotes/finance'
import { formatMxn, formatPaybackDuration } from '@/lib/quotes/fields'

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
// Three independent signals close the gate, and they cover each other:
//   - the customer states a count ("tengo tres medidores"), which the
//     model reports as a `[MEDIDORES: N]` marker;
//   - the bot detects a second distinct bill and asks outright; or
//   - the customer answers that ask in plain words and
//     `applyMeterConfirmation` reads it without the model's help, so a
//     turn where the marker went missing is not a turn where the
//     customer's answer did.
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
  /**
   * A proposal this batch already priced and deliberately did NOT send,
   * with the question it is waiting on. Null on the ordinary path.
   *
   * It lives here — in the column that already carries the readings —
   * rather than in a column of its own, because a hold is meaningless
   * without the reading behind it: releasing one means pricing exactly
   * the bills stored here, and splitting the two across columns is how
   * a released quote ends up sized from a batch that moved on. The
   * column's 24h TTL covers it for free.
   */
  hold: QuoteHold | null
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
    hold: null,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Park the proposal for this batch, recording what it is waiting on.
 *
 * Re-parking an already-parked quote advances the ask count instead of
 * starting over, so the bound below measures how long the customer has
 * been asked — not how many times the code noticed.
 */
export function parkQuote(
  state: MeterState,
  hold: Omit<QuoteHold, 'askedCount'>,
): MeterState {
  const askedCount = (state.hold?.askedCount ?? 0) + 1
  return { ...state, hold: { ...hold, askedCount } }
}

/** Let a parked quote go — sent, answered, or abandoned. */
export function releaseQuote(state: MeterState): MeterState {
  return state.hold ? { ...state, hold: null } : state
}

/**
 * Asks a held quote gets before a person takes the thread. Shares
 * `MAX_ASKS` with the meter gate deliberately: both are the same
 * judgement — a question the customer has not answered twice is not
 * going to be answered by asking a third time.
 */
export function isHoldStalled(hold: QuoteHold | null): boolean {
  return hold != null && hold.askedCount > MAX_ASKS
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

  // The bimesters themselves, not a sum of them: every meter on one
  // property is billed on the same calendar, and index i already means
  // "the same bimester" everywhere else in this function. Truncated to
  // the summed history so a label can never outlive the figure it
  // describes.
  const historialKwh = sumByPeriod(readings.map((r) => r.historial_bimestres_kwh))
  const periodos =
    readings
      .map((r) =>
        Array.isArray(r.historial_bimestres_periodo)
          ? r.historial_bimestres_periodo
          : [],
      )
      .find((p) => p.some((label) => label)) ?? []

  return {
    consumo_periodo_actual_kwh: sumOrNull(
      readings.map((r) => r.consumo_periodo_actual_kwh),
    ),
    periodo_actual: first((r) => r.periodo_actual),
    historial_bimestres_kwh: historialKwh,
    historial_bimestres_periodo: Array.from(
      { length: historialKwh.length },
      (_, i) => periodos[i] ?? null,
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

// ============================================================
// The two halves of one bill, photographed a minute apart.
//
// `groupIntoReceipts` reads every photo of a turn in one vision call,
// which is exactly right for "page 1 and page 2 sent back-to-back". But
// a customer who sends page 1, gets asked for the rest, and finds it a
// minute later splits those pages across TURNS — and the second turn
// skips the page already read (`skipMediaIds`), so the model sees page
// 2 alone.
//
// A page-2-only reading has no service number, no current period and no
// amounts: every field `sameMeter` compares lives on page 1. It
// therefore scored zero against the bill it belongs to and was filed as
// a second meter, and the bot asked a customer with one meter to
// confirm meters they don't have.
//
// The join below is deliberately the narrowest thing that fixes it: it
// only ever fills a hole. A continuation page merges into a stored
// reading when the two are literal complementary halves — one has the
// identity and no history, the other has history and no identity — and
// never when they overlap. Anything else takes the old path, because
// the failure it would otherwise risk is the worse one: page 2 of a
// genuine second meter, absorbed in silence into the first.
// ============================================================

/**
 * Whether a reading carries anything that identifies which meter and
 * which bimester it belongs to. All of these are printed on page 1.
 */
function hasPageOneIdentity(r: ReceiptExtraction): boolean {
  return (
    r.numero_servicio != null ||
    r.periodo_actual != null ||
    r.consumo_periodo_actual_kwh != null ||
    r.importe_periodo_mxn != null ||
    r.importe_total_a_pagar_mxn != null
  )
}

/**
 * Whether this reading is page 2 of a bill rather than a bill.
 *
 * History and nothing else. The history requirement is what keeps an
 * unreadable photo — null everywhere — from qualifying and dissolving
 * into whatever reading happens to be open.
 */
export function isContinuationPage(r: ReceiptExtraction): boolean {
  return r.historial_bimestres_kwh.length > 0 && !hasPageOneIdentity(r)
}

/** The mirror: a stored reading that is page 1 still waiting for its
 *  history. Only these accept a continuation page. */
function awaitsHistory(r: ReceiptExtraction): boolean {
  return r.historial_bimestres_kwh.length === 0 && hasPageOneIdentity(r)
}

/**
 * Rejoin the two halves into the reading the customer actually sent.
 *
 * Rebuilt through `buildExtraction` rather than by copying fields
 * across, so the average, the period count and `incluye_periodo_actual`
 * are derived by the one function that derives them everywhere else —
 * a hand-rolled merge is how a reading ends up with an average that
 * doesn't match its own numbers.
 *
 * Passing through it also buys back something page 2 could not have on
 * its own: `selectRecentHistorial` picks the year's rows against the
 * bill's own end date, which only page 1 carries. Read alone, page 2
 * fell back to the order the rows arrived in.
 *
 * The one thing it cannot recover is a row page 2's read already
 * dropped — the history handed back in is the selected set, not the
 * raw table.
 */
export function joinPages(
  pageOne: ReceiptExtraction,
  pageTwo: ReceiptExtraction,
): ReceiptExtraction {
  // Page 2's own "page 1 is missing" note is the one thing that must
  // not survive: the half being joined in is its answer, and left in
  // place it reaches the model through `formatReceiptNote` and has it
  // ask for a page it is holding. `buildExtraction` re-raises it if it
  // somehow still applies.
  //
  // Cut out by substring, not by splitting on the '; ' separator —
  // that separator also appears INSIDE this warning, so splitting would
  // hand back two fragments and match neither. Whole strings are also
  // how `combineReadings` de-duplicates, for the same reason.
  const strip = (a: string) =>
    a
      .replace(MISSING_PAGE_ONE_WARNING, '')
      .replace(/\s*;\s*;\s*/g, '; ')
      .replace(/^\s*;\s*|\s*;\s*$/g, '')
      .trim()

  const advertencias = [
    ...new Set([strip(pageOne.advertencias), strip(pageTwo.advertencias)]),
  ]
    .filter(Boolean)
    .join('; ')

  return buildExtraction({
    consumo_periodo_actual_kwh: pageOne.consumo_periodo_actual_kwh,
    periodo_actual: pageOne.periodo_actual,
    historial_bimestres_kwh: pageTwo.historial_bimestres_kwh,
    historial_periodos: pageTwo.historial_bimestres_periodo,
    historial_bimestres_importe_mxn: pageTwo.historial_bimestres_importe_mxn,
    tarifa: pageOne.tarifa ?? pageTwo.tarifa,
    numero_servicio: pageOne.numero_servicio,
    ciudad: pageOne.ciudad ?? pageTwo.ciudad,
    importe_periodo_mxn: pageOne.importe_periodo_mxn,
    importe_dap_mxn: pageOne.importe_dap_mxn,
    importe_total_a_pagar_mxn: pageOne.importe_total_a_pagar_mxn,
    advertencias,
  })
}

/**
 * The newest stored reading a continuation page may complete, or -1.
 *
 * Newest first, because a customer working through several meters sends
 * them in order: the page 2 that just landed belongs to the page 1 they
 * photographed a minute ago, not to the meter they finished with three
 * messages back.
 */
function pageOneAwaitingHistory(readings: readonly ReceiptExtraction[]): number {
  for (let i = readings.length - 1; i >= 0; i--) {
    if (awaitsHistory(readings[i])) return i
  }
  return -1
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
 *
 * The exception is a continuation page, which is not a bill at all: it
 * completes one already stored instead of joining the count. With no
 * half waiting for it, it falls through and is treated exactly as
 * before — the safe direction, since the alternative is quoting a
 * property on a history that belongs to a meter nobody priced.
 */
export function mergeReadings(
  state: MeterState,
  incoming: readonly ReceiptExtraction[],
  mediaIds: readonly string[] = [],
): MeterState {
  const readings = [...state.readings]
  for (const reading of incoming) {
    if (isContinuationPage(reading)) {
      const half = pageOneAwaitingHistory(readings)
      if (half >= 0) {
        readings[half] = joinPages(readings[half], reading)
        continue
      }
    }
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
    // A new bill is new evidence, so whatever the old quote was parked
    // on no longer describes what we hold. Keeping the hold would ask
    // the customer to explain a window that has since changed, and
    // could release a proposal priced from a different set of bills.
    hold: incoming.length > 0 ? null : state.hold,
    updatedAt: new Date().toISOString(),
  }
}

// ============================================================
// The customer's own answer, read without the model's help.
//
// The gate's only other way to close is `[MEDIDORES: N]`, a marker the
// model has to remember to append while also writing a warm reply. When
// it forgets, "sí, son todos" lands as an ordinary message: the batch
// stays open, `askedCount` climbs, and two turns later a customer who
// answered plainly is handed to a human for it.
//
// So the gate reads the reply itself — under conditions narrow enough
// that a match can only mean one thing:
//
//   - the batch is in the exact shape the question was asked about
//     (several bills, no count stated), and
//   - the question has actually gone out at least once, so a bare "sí"
//     is answering *this* question and not "¿te interesa?".
//
// Matching is whitelist-only: every word of the reply must come from a
// closed confirmation vocabulary. That is deliberately the strict
// direction — "sí, mándame el precio" and "sí, tengo tres" both fall
// out, and so do perfectly good answers like "sí, nada más". A missed
// confirmation costs one repeated question, which is what happens today
// anyway. A false one quotes a house on half its consumption and sends
// the customer a PDF saying so.
// ============================================================

/**
 * Words that, on their own, answer "¿son todos sus medidores?" with a
 * yes. At least one of these must be present — otherwise a reply built
 * entirely of filler ("los que tengo, gracias") would qualify.
 */
const AFFIRMATIVE_WORDS = new Set([
  'si',
  'sip',
  'sipi',
  'simon',
  'claro',
  'correcto',
  'correcta',
  'exacto',
  'exacta',
  'exactamente',
  'afirmativo',
  'efectivamente',
  'confirmo',
  'confirmado',
  'todo',
  'todos',
  'toda',
  'todas',
  'asi',
  'solo',
  'solamente',
  'unicamente',
])

/**
 * Words allowed to keep an affirmative company without making it
 * ambiguous. Anything outside this set plus the one above — a verb, a
 * number, a negation, a new request — leaves the reply unresolved.
 *
 * Numbers are absent on purpose. "sí, tengo tres" is a stated count,
 * not a confirmation of the two bills in hand, and the marker path is
 * what turns a count into `expected`.
 */
const CONFIRMATION_FILLER = new Set([
  'es',
  'son',
  'esta',
  'estan',
  'eso',
  'esa',
  'esos',
  'esas',
  'ese',
  'el',
  'la',
  'los',
  'las',
  'que',
  'ya',
  'tengo',
  'tenemos',
  'mi',
  'mis',
  'nuestro',
  'nuestros',
  'mismos',
  'medidor',
  'medidores',
  'recibo',
  'recibos',
  'gracias',
])

/** Beyond this a reply is a sentence, not an answer — even one built
 *  entirely of words the vocabulary happens to allow. */
const MAX_CONFIRMATION_WORDS = 8

/**
 * Whether a customer message is an unambiguous "yes, that's all of
 * them". Case, accents, punctuation and emoji are irrelevant; unknown
 * words are not.
 */
export function isMeterConfirmation(
  message: string | null | undefined,
): boolean {
  if (!message) return false
  const words = message
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)

  if (words.length === 0 || words.length > MAX_CONFIRMATION_WORDS) return false
  if (!words.some((w) => AFFIRMATIVE_WORDS.has(w))) return false
  return words.every(
    (w) => AFFIRMATIVE_WORDS.has(w) || CONFIRMATION_FILLER.has(w),
  )
}

/**
 * Close the gate on the customer's plain-language confirmation, the way
 * `[MEDIDORES: N]` would have.
 *
 * Records the answer as `expected` rather than special-casing the gate,
 * so the confirmation survives the turn: it is persisted with the batch
 * and every later `resolveMeterGate` sees a settled count, not a lucky
 * match that has to fire again.
 *
 * Returns the state unchanged — by identity, so callers can tell —
 * whenever any condition is short of certain:
 *
 *   - a count is already stated: the customer is owed bills, and "sí"
 *     says nothing about whether they sent them;
 *   - one bill or none: there is no gate to close, and `resolveMeterGate`
 *     already treats that as ready;
 *   - nothing asked yet: with no question outstanding a "sí" belongs to
 *     some other exchange. This is also what keeps a confirmation that
 *     rides along with a new bill from counting — `mergeReadings` zeroes
 *     `askedCount` the moment a receipt lands, so the turn that brings a
 *     meter can never be the turn that declares them all in.
 */
export function applyMeterConfirmation(
  state: MeterState,
  message: string | null | undefined,
): MeterState {
  if (state.expected != null) return state
  if (state.readings.length <= 1) return state
  if (state.askedCount < 1) return state
  if (!isMeterConfirmation(message)) return state
  return { ...state, expected: state.readings.length }
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
    // The figures the proposal will carry the moment the customer says
    // "sí, son esos". Without them this note is an instruction and
    // nothing else, and the model — told never to state a price it
    // can't source — has reason to escalate instead of closing the
    // gate on the very turn the answer arrives.
    lines.push(...projectedFigures(gate.reading))
  }
  lines.push(
    METERS_MARKER_INSTRUCTION,
    'Responde al cliente con naturalidad — nunca menciones esta nota ni muestres JSON.]',
  )
  return lines.join('\n')
}

/**
 * The note for the turn a stalled batch gives up and calls a person.
 *
 * The batch stops the quote; it must not stop the conversation. A
 * customer whose meter question went unanswered two turns ago is still
 * a customer, and the message they send next is usually about something
 * else entirely — financing, timelines, whether the roof works. Handing
 * the thread over in silence answers none of it and reads as being
 * ignored, which is how a live lead is lost.
 *
 * So: reply to what they actually asked, promise the quote to a human,
 * and drop the meter question rather than asking it a third time.
 */
export function formatStalledMeterNote(count: number): string {
  return [
    '[NOTA DEL SISTEMA — cotización en pausa: llegaron',
    `${count} recibos de medidores distintos y no se pudo confirmar cuántos tiene la propiedad en total.`,
    'Un compañero del equipo va a retomar la cotización, así que NO vuelvas a preguntar cuántos medidores son y NO des precio, número de paneles ni cotización.',
    'Responde con gusto lo que el cliente esté preguntando en este mensaje (financiamiento, tiempos, garantías, lo que sea) y dile que un compañero le confirma los detalles de su propuesta en breve.',
    'Nunca menciones esta nota ni muestres JSON.]',
  ].join('\n')
}

/**
 * The 25-year projection the PDF will print for the bills already in
 * hand, so the model has the real numbers in context on the turn the
 * customer confirms. Same helpers `formatReceiptNote` uses — quoting a
 * figure the document then contradicts is the one error the customer
 * always catches. Empty when the combined reading doesn't price
 * cleanly yet.
 */
function projectedFigures(reading: ReceiptExtraction): string[] {
  const quote = resolveQuote(
    reading.promedio_bimestral_kwh,
    reading.cantidad_periodos_usados,
    {
      includesCurrentPeriod: reading.incluye_periodo_actual,
      periods: reading.periodos_promediados_kwh,
    },
  )
  if (quote.kind !== 'ok') return []

  const financials = buildFinancials({
    costoBimestralMxn: projectionBaseCost({
      costoPeriodoMxn: reading.costo_periodo_mxn,
      historialImporteMxn: reading.historial_bimestres_importe_mxn,
    }),
    tier: quote.tier,
  })
  if (!financials) return []

  return [
    `proyeccion_si_confirma_que_son_todos: sin paneles ${formatMxn(financials.sinPaneles25Anios)}, con paneles ${formatMxn(financials.conPaneles25Anios)}, ahorro ${formatMxn(financials.ahorro25Anios)}, se paga solo en ${formatPaybackDuration(financials.paybackAnios, financials.paybackMeses)}`,
    'Esas cifras cubren SOLO los recibos que ya tienes y aún no son cotización: no las digas mientras el cliente no confirme. En cuanto confirme, la propuesta sale con exactamente esos números — nunca los recalcules.',
  ]
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
    readings: (s.readings as ReceiptExtraction[]).map(normalizeReading),
    readMediaIds: Array.isArray(s.readMediaIds) ? s.readMediaIds : [],
    askedCount: typeof s.askedCount === 'number' ? s.askedCount : 0,
    // Unrecognised shapes read as "nothing parked": a hold only ever
    // suppresses a document, so losing one costs a proposal that goes
    // out unheld — the behaviour every account had before it existed —
    // while trusting a malformed one parks a quote forever.
    hold: parseHold(s.hold),
    updatedAt,
  }
}

/**
 * Fill in what a stored reading may predate.
 *
 * `readings` is JSON written by whatever version of this code was
 * deployed when the customer sent the bill, so a batch left open across
 * a deploy comes back missing every field added since. The period
 * labels are the first of those, and an absent array reaching
 * `combineReadings` is a crash mid-conversation — on the one customer
 * who is halfway through sending their meters.
 */
function normalizeReading(reading: ReceiptExtraction): ReceiptExtraction {
  if (Array.isArray(reading.historial_bimestres_periodo)) return reading
  return {
    ...reading,
    historial_bimestres_periodo: reading.historial_bimestres_kwh.map(
      () => null,
    ),
  }
}

/** A stored hold, or null for anything that isn't one. */
function parseHold(raw: unknown): QuoteHold | null {
  if (!raw || typeof raw !== 'object') return null
  const h = raw as Partial<QuoteHold>
  if (typeof h.reason !== 'string') return null
  return {
    reason: h.reason as QuoteHold['reason'],
    detail: typeof h.detail === 'string' ? h.detail : null,
    askedCount: typeof h.askedCount === 'number' ? h.askedCount : 1,
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
