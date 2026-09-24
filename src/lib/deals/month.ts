import type { Deal, DealStatus, PipelineStage } from '@/types'

/**
 * The pipeline board shows one calendar month at a time.
 *
 * A deal belongs to month M when it was alive at some point during M:
 * created before M ended, and either still open or closed (won/lost)
 * on or after M started. So the current month shows everything new,
 * everything still open from earlier months ("carried over"), and what
 * was won or lost this month — lost deals from earlier months drop off.
 *
 * Months are cut in the business's time zone, not the browser's or
 * UTC: a deal created at 11pm on the 31st in Mexico City belongs to
 * that month.
 */

export const PIPELINE_TIME_ZONE = 'America/Mexico_City'

/** 'YYYY-MM' */
export type MonthKey = string

export interface MonthRange {
  key: MonthKey
  start: Date
  end: Date
  startIso: string
  endIso: string
}

const MONTH_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

export function isMonthKey(value: unknown): value is MonthKey {
  return typeof value === 'string' && MONTH_KEY_RE.test(value)
}

function parseKey(key: MonthKey): { year: number; month: number } {
  const match = MONTH_KEY_RE.exec(key)
  if (!match) throw new Error(`Invalid month key: ${key}`)
  return { year: Number(match[1]), month: Number(match[2]) }
}

function toKey(year: number, month: number): MonthKey {
  return `${year}-${String(month).padStart(2, '0')}`
}

/** The month `date` falls in, in `timeZone`. */
export function monthKeyOf(date: Date, timeZone = PIPELINE_TIME_ZONE): MonthKey {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date)
  const year = parts.find((p) => p.type === 'year')?.value
  const month = parts.find((p) => p.type === 'month')?.value
  return `${year}-${month}`
}

export function shiftMonth(key: MonthKey, delta: number): MonthKey {
  const { year, month } = parseKey(key)
  const index = year * 12 + (month - 1) + delta
  return toKey(Math.floor(index / 12), (index % 12) + 1)
}

/** Every month from `from` to `to`, newest first. Empty if `from` > `to`. */
export function monthsBetween(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = []
  for (let key = to; key >= from; key = shiftMonth(key, -1)) out.push(key)
  return out
}

/**
 * "September 2026" / "Sep". Uses the runtime's default locale, like the
 * rest of the board's dates (deal-card.tsx); pinned to UTC because the
 * key is already a calendar month, not an instant.
 */
export function formatMonth(key: MonthKey, style: 'long' | 'short'): string {
  const { year, month } = parseKey(key)
  const date = new Date(Date.UTC(year, month - 1, 15))
  return date.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: style,
    ...(style === 'long' ? { year: 'numeric' } : {}),
  })
}

/** Minutes east of UTC that `timeZone` observes at `instant`. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName')?.value
  // "GMT", "GMT-06:00", "GMT+05:30"
  const match = name ? /GMT([+-])(\d{2}):(\d{2})/.exec(name) : null
  if (!match) return 0
  const minutes = Number(match[2]) * 60 + Number(match[3])
  return match[1] === '-' ? -minutes : minutes
}

/** The instant local midnight starts on the 1st of `key` in `timeZone`. */
function monthStartInstant(key: MonthKey, timeZone: string): Date {
  const { year, month } = parseKey(key)
  const wallClock = Date.UTC(year, month - 1, 1)
  // Two passes settle the offset even if a DST change sits near midnight.
  let instant = wallClock - offsetMinutes(new Date(wallClock), timeZone) * 60_000
  instant = wallClock - offsetMinutes(new Date(instant), timeZone) * 60_000
  return new Date(instant)
}

export function monthRange(key: MonthKey, timeZone = PIPELINE_TIME_ZONE): MonthRange {
  const start = monthStartInstant(key, timeZone)
  const end = monthStartInstant(shiftMonth(key, 1), timeZone)
  return { key, start, end, startIso: start.toISOString(), endIso: end.toISOString() }
}

function at(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function inRange(value: string | null | undefined, range: MonthRange): boolean {
  const ms = at(value)
  return ms !== null && ms >= range.start.getTime() && ms < range.end.getTime()
}

/** Alive during the month — the rule the board query applies server-side. */
export function isAliveDuring(deal: Deal, range: MonthRange): boolean {
  const created = at(deal.created_at)
  if (created === null || created >= range.end.getTime()) return false
  if ((deal.status ?? 'open') === 'open') return true
  const closed = at(deal.closed_at)
  return closed === null || closed >= range.start.getTime()
}

/** Created before the month began — shown with a "From <month>" badge. */
export function isCarriedOver(deal: Deal, range: MonthRange): boolean {
  const created = at(deal.created_at)
  return created !== null && created < range.start.getTime()
}

/**
 * The status the deal had when the month ended. Browsing a past month,
 * a deal won later still counted as open back then.
 */
export function statusAsOfMonthEnd(deal: Deal, range: MonthRange): DealStatus {
  const status = deal.status ?? 'open'
  if (status === 'open') return 'open'
  const closed = at(deal.closed_at)
  return closed !== null && closed >= range.end.getTime() ? 'open' : status
}

/**
 * Probability a deal in `stage` closes: 10% in the first stage rising
 * to 90% before the last, 100% in the last (won) stage.
 */
export function stageProbability(stage: PipelineStage, sortedStages: PipelineStage[]): number {
  const n = sortedStages.length
  if (n <= 1) return 1
  const index = sortedStages.findIndex((s) => s.id === stage.id)
  if (index < 0) return 0
  if (index === n - 1 || stage.is_won) return 1
  const slots = n - 1
  if (slots <= 1) return 0.1
  const t = index / (slots - 1)
  return 0.1 + t * (0.9 - 0.1)
}

export interface MonthStats {
  /** Created this month. */
  newCount: number
  /** First proposal sent this month. */
  quotedCount: number
  wonCount: number
  wonValue: number
  lostCount: number
  /** Lost this month, by `lost_reason` ('' for none given). */
  lostByReason: Record<string, number>
  /** Still open when the month ended (or now, for the current month). */
  openCount: number
  openValue: number
  weightedValue: number
}

export function computeMonthStats(
  deals: Deal[],
  stages: PipelineStage[],
  range: MonthRange,
): MonthStats {
  const sortedStages = [...stages].sort((a, b) => a.position - b.position)
  const stageById = new Map(sortedStages.map((s) => [s.id, s]))
  const stats: MonthStats = {
    newCount: 0,
    quotedCount: 0,
    wonCount: 0,
    wonValue: 0,
    lostCount: 0,
    lostByReason: {},
    openCount: 0,
    openValue: 0,
    weightedValue: 0,
  }

  for (const deal of deals) {
    if (!isAliveDuring(deal, range)) continue
    const value = Number(deal.value || 0)
    if (inRange(deal.created_at, range)) stats.newCount += 1
    if (inRange(deal.quoted_at, range)) stats.quotedCount += 1

    const status = statusAsOfMonthEnd(deal, range)
    if (status === 'open') {
      stats.openCount += 1
      stats.openValue += value
      const stage = stageById.get(deal.stage_id)
      if (stage) stats.weightedValue += value * stageProbability(stage, sortedStages)
    } else if (inRange(deal.closed_at, range)) {
      if (status === 'won') {
        stats.wonCount += 1
        stats.wonValue += value
      } else {
        stats.lostCount += 1
        const reason = deal.lost_reason ?? ''
        stats.lostByReason[reason] = (stats.lostByReason[reason] ?? 0) + 1
      }
    }
  }

  return stats
}
