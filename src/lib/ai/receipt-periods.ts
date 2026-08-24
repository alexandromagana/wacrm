// ============================================================
// Which bimesters of the historial table actually belong in the average.
//
// The vision model used to be asked to do this itself: out of a table
// that can print a dozen look-alike rows, report "the 5 most recent,
// newest first". That is a selection, an ordering and a transcription in
// one brevity-constrained pass, with nothing downstream able to tell a
// good answer from a bad one — the average was computed in code from
// whatever five numbers came back, exactly as if they were the right
// five.
//
// A real bill priced at 8 panels instead of 6 that way: a $13,100
// difference on a document the customer keeps, from a window nobody
// could audit after the fact.
//
// So the model now transcribes rows and their period labels, and the
// choosing happens here, in code, against real dates. Same instinct as
// `buildExtraction` never letting the model average, and `pricing.ts`
// never letting it map kWh to a price.
//
// Everything here is pure and total: no throw reaches the caller, and
// anything it cannot read with confidence degrades to the old behaviour
// (trust the reported order, take the first N) rather than guessing.
// ============================================================

/**
 * Historial rows the model may report before we stop reading.
 *
 * Higher than `MAX_HISTORIAL_BIMESTRES` on purpose: the model now hands
 * over everything it can see and code picks the recent ones, so this is
 * a transcription ceiling, not a selection one. CFE prints up to twelve.
 */
export const MAX_HISTORIAL_RAW_ROWS = 12

/** Spanish month abbreviations as CFE prints them. SET is a variant of
 *  SEP seen on some bills; both map to September. */
const MONTHS: Record<string, number> = {
  ENE: 0,
  FEB: 1,
  MAR: 2,
  ABR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AGO: 7,
  SEP: 8,
  SET: 8,
  OCT: 9,
  NOV: 10,
  DIC: 11,
}

/** Shortest and longest a real billing period may run, in days. Wide
 *  enough for a monthly PDBT bill and a long bimester alike, narrow
 *  enough that a mis-parse spanning years is rejected outright. */
const MIN_PERIOD_DAYS = 20
const MAX_PERIOD_DAYS = 100

const DAY_MS = 24 * 60 * 60_000

/** Days between two dates, signed. */
function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS
}

/**
 * Two-digit years as CFE prints them ("26"), widened to the century the
 * bill was actually issued in. Four-digit years pass through.
 */
function expandYear(raw: number): number {
  return raw >= 100 ? raw : 2000 + raw
}

/** One parsed billing period. */
export interface ParsedPeriodo {
  start: Date
  end: Date
}

/**
 * Read a CFE period label into real dates, or null when it is not one.
 *
 * Handles the shapes that actually appear on a bill — "del 10 ABR 26 al
 * 12 JUN 26", "12 JUN 26-13 AGO 26", "10 ABR - 12 JUN 26" — by pulling
 * out every `DD MES [YY]` token and requiring exactly two. The prose
 * around them ("del", "al", stray dashes) is ignored rather than matched,
 * which is what keeps this working across the wording variants instead
 * of one format at a time.
 *
 * A start date with no year borrows it from the end, rolling back a year
 * when the period crosses December into January — the one case where
 * "same year as the end" is wrong.
 */
export function parsePeriodoLabel(
  label: string | null | undefined,
): ParsedPeriodo | null {
  if (typeof label !== 'string' || !label.trim()) return null

  const normalized = label
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()

  const tokens = [
    ...normalized.matchAll(/(\d{1,2})\s*[-. ]?\s*([A-Z]{3})\.?\s*(\d{2,4})?/g),
  ]
  if (tokens.length !== 2) return null

  const parsed = tokens.map((t) => ({
    day: Number(t[1]),
    month: MONTHS[t[2]],
    year: t[3] != null ? expandYear(Number(t[3])) : null,
  }))
  if (parsed.some((p) => p.month === undefined || !p.day || p.day > 31)) {
    return null
  }

  const [rawStart, rawEnd] = parsed
  // The end date carries the year on every layout we have seen. Without
  // one there is nothing to anchor the pair to, and a guess here would
  // silently sort the whole window wrong.
  if (rawEnd.year == null) return null

  const startYear =
    rawStart.year ??
    (rawStart.month > rawEnd.month ? rawEnd.year - 1 : rawEnd.year)

  const start = new Date(Date.UTC(startYear, rawStart.month, rawStart.day))
  const end = new Date(Date.UTC(rawEnd.year, rawEnd.month, rawEnd.day))
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null

  const span = daysBetween(start, end)
  if (span < MIN_PERIOD_DAYS || span > MAX_PERIOD_DAYS) return null

  return { start, end }
}

/** One historial row as reported, before anything is decided about it. */
export interface HistorialCandidate {
  kwh: number
  /** The row's importe, kept married to its kWh so a selection can never
   *  shift the money column out of step with the consumption one. */
  importeMxn: number | null
  /** The period label as printed, or null when it could not be read. */
  periodo: string | null
}

export interface HistorialSelectionResult {
  /** The rows that belong in the average, newest first. */
  selected: HistorialCandidate[]
  /** True when real dates drove the choice, false on the fallback path. */
  usedDateOrdering: boolean
  /** Something worth telling a human, or null. Advisory only: a warning
   *  never blocks a quote by itself. */
  warning: string | null
}

/** Take the first `limit` in the order reported — what this module did
 *  before it existed, and what it still does whenever the dates cannot
 *  be trusted end to end. */
function fallback(
  candidates: readonly HistorialCandidate[],
  limit: number,
  warning: string | null = null,
): HistorialSelectionResult {
  return {
    selected: candidates.slice(0, limit),
    usedDateOrdering: false,
    warning,
  }
}

/**
 * Choose the `limit` most recent historial rows.
 *
 * Uses real dates when — and only when — every row carries one that
 * parses. The gate is all-or-nothing on purpose: a window where half the
 * labels read and half did not cannot be ordered against itself, and
 * mixing "sorted by date" with "wherever the model happened to put it"
 * produces a window that looks authoritative and is not. One bad label
 * drops the whole window back to the old behaviour, where the anomaly
 * checks in `pricing.ts` are still watching.
 *
 * `currentPeriodEnd` is the bill's own period, when it could be read.
 * Rows that are not strictly older than it are dropped: a historial
 * table lists prior periods by definition, so a row that isn't one is
 * either the current bimester repeated — which would double-count it in
 * the average — or a misread date.
 */
export function selectRecentHistorial(
  candidates: readonly HistorialCandidate[],
  limit: number,
  currentPeriodEnd: Date | null = null,
): HistorialSelectionResult {
  if (candidates.length === 0) {
    return { selected: [], usedDateOrdering: false, warning: null }
  }
  if (limit <= 0) return { selected: [], usedDateOrdering: false, warning: null }

  const dated = candidates.map((c) => ({
    candidate: c,
    periodo: parsePeriodoLabel(c.periodo),
  }))
  if (dated.some((d) => d.periodo == null)) return fallback(candidates, limit)

  const readable = dated as {
    candidate: HistorialCandidate
    periodo: ParsedPeriodo
  }[]

  const notes: string[] = []

  // Anything not strictly older than the bill's own period. Dropped
  // rather than tolerated: the newest one is usually the current
  // bimester listed twice, which would weight it double in the average.
  let usable = readable
  if (currentPeriodEnd) {
    const prior = readable.filter(
      (d) => d.periodo.end.getTime() < currentPeriodEnd.getTime(),
    )
    if (prior.length !== readable.length) {
      notes.push(
        'se ignoró un renglón del historial que no es anterior al periodo facturado',
      )
    }
    if (prior.length === 0) return fallback(candidates, limit, notes[0] ?? null)
    usable = prior
  }

  // Newest first, by the date on the paper rather than the order the
  // model happened to report.
  const sorted = [...usable].sort(
    (a, b) => b.periodo.end.getTime() - a.periodo.end.getTime(),
  )

  // A repeated period means the model transcribed one row twice, which
  // usually means another row never made it out. Sorting is still sound,
  // so the duplicate is dropped and the gap check below reports what it
  // left behind.
  const seen = new Set<number>()
  const unique = sorted.filter((d) => {
    const key = d.periodo.end.getTime()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (unique.length !== sorted.length) {
    notes.push('el historial traía un bimestre repetido')
  }

  const selected = unique.slice(0, limit)

  // Adjacent periods should meet: the older row's end is the newer row's
  // start, give or take CFE's own reading-date drift. A real gap means a
  // bimester is missing from the window, which quietly ages the average.
  const hasGap = selected.some((d, i) => {
    if (i === 0) return false
    const newer = selected[i - 1].periodo
    return Math.abs(daysBetween(d.periodo.end, newer.start)) > 20
  })
  if (hasGap) {
    notes.push('el historial salta bimestres, así que el promedio no cubre un año seguido')
  }

  return {
    selected: selected.map((d) => d.candidate),
    usedDateOrdering: true,
    warning: notes.length > 0 ? notes.join('; ') : null,
  }
}
