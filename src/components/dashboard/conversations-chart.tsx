"use client"

import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare } from '@/components/animated-icons'
import type { ConversationsSeriesPoint } from '@/lib/dashboard/types'
import { EmptyState, LoadError } from './empty-state'
import { Skeleton } from './skeleton'
import { cn } from '@/lib/utils'

type RangeDays = 7 | 30 | 90

interface ConversationsChartProps {
  /** Per-range data, so switching tabs never re-fetches. */
  series: Record<RangeDays, ConversationsSeriesPoint[] | null>
  loading: boolean
  failed: boolean
  onRetry: () => void
  range: RangeDays
  onRangeChange: (r: RangeDays) => void
  /** Pre-formatted "Agents sent 12 messages today · …" line. */
  todayNote?: string
}

// Customer messages carry the accent; replies are the neutral second
// series, drawn dashed so the two read apart without colour.
const INCOMING = 'var(--primary)'
const OUTGOING = 'var(--muted-foreground)'
const OUTGOING_DASH = '5 4'

// ------------------------------------------------------------
// Layout constants. The viewBox width tracks the container's real
// width (see LineSvg), so one unit is one pixel and the axis text
// renders at its set size. A fixed 760-wide viewBox scaled down to a
// phone shrank the labels to ~4px. VB_W is only the first-paint guess.
// ------------------------------------------------------------
const VB_W = 760
const VB_H = 240
/** Roughly one x-axis label per this many pixels. */
const LABEL_SPACING = 72
const PADDING = { top: 16, right: 16, bottom: 28, left: 40 }

import { useTranslations } from 'next-intl'

export function ConversationsChart({
  series,
  loading,
  failed,
  onRetry,
  range,
  onRangeChange,
  todayNote,
}: ConversationsChartProps) {
  const t = useTranslations('Dashboard.conversationsChart')
  const data = series[range]
  const totals = useMemo(
    () =>
      (data ?? []).reduce(
        (acc, p) => ({ incoming: acc.incoming + p.incoming, outgoing: acc.outgoing + p.outgoing }),
        { incoming: 0, outgoing: 0 },
      ),
    [data],
  )

  // Memoise the max so per-day hover math doesn't recompute it.
  const { maxY, niceTicks } = useMemo(() => {
    const arr = data ?? []
    const max = arr.reduce(
      (m, p) => Math.max(m, p.incoming, p.outgoing),
      0,
    )
    const ceil = niceCeil(max)
    const ticks = [0, ceil / 4, ceil / 2, (3 * ceil) / 4, ceil].map((v) =>
      Math.round(v),
    )
    // De-dupe when the series is flat 0.
    return { maxY: ceil, niceTicks: Array.from(new Set(ticks)) }
  }, [data])

  return (
    <section aria-labelledby="messages-chart-title" className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h3 id="messages-chart-title" className="text-sm font-semibold text-foreground">{t('title')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description', { count: range })}</p>
          {todayNote && <p className="mt-1 text-xs text-muted-foreground tabular-nums">{todayNote}</p>}
        </div>
        <div role="group" aria-label={t('rangeLabel')} className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
          {[7, 30, 90].map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onRangeChange(r as RangeDays)}
              aria-pressed={range === r}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                range === r
                  ? 'bg-card text-foreground ring-1 ring-border'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t('days', { count: r })}
            </button>
          ))}
        </div>
      </header>

      <div className="p-5">
        {!data && failed && !loading ? (
          <LoadError onRetry={onRetry} />
        ) : !data ? (
          <Skeleton className="h-[240px] w-full" />
        ) : data.every((p) => p.incoming === 0 && p.outgoing === 0) ? (
          <EmptyState
            icon={MessageSquare}
            title={t('noActivity')}
            hint={t('noActivityHint')}
          />
        ) : (
          <LineSvg data={data} maxY={maxY} ticks={niceTicks} t={t} />
        )}
      </div>

      <footer className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border px-5 py-3 text-xs text-muted-foreground">
        <LegendLine color={INCOMING} label={t('incoming')} total={data ? totals.incoming : null} t={t} />
        <LegendLine color={OUTGOING} dash={OUTGOING_DASH} label={t('outgoing')} total={data ? totals.outgoing : null} t={t} />
      </footer>
    </section>
  )
}

// ------------------------------------------------------------
// The actual SVG. Two polylines + per-day hit targets for hover.
// ------------------------------------------------------------

function LineSvg({
  data,
  maxY,
  ticks,
  t
}: {
  data: ConversationsSeriesPoint[]
  maxY: number
  ticks: number[]
  t: ReturnType<typeof useTranslations>
}) {
  // Hover state: both the snapped index AND the tooltip's pixel
  // offset inside the wrapper div. They're stored together so the
  // tooltip positions against the chart's actual rendered pixels,
  // not against a raw viewBox percentage. See the precision note on
  // the onMove handler below.
  const [hover, setHover] = useState<{ idx: number; tooltipLeftPx: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [vbW, setVbW] = useState(VB_W)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width)
      if (width > 0) setVbW(width)
    })
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  const chartW = vbW - PADDING.left - PADDING.right
  const chartH = VB_H - PADDING.top - PADDING.bottom

  // x step can be fractional for 90-day views; points are positioned
  // at the center of each "slot" so the first and last points don't
  // sit right on the axis.
  const stepX = data.length > 1 ? chartW / (data.length - 1) : 0
  const yFor = (v: number) =>
    maxY === 0 ? PADDING.top + chartH : PADDING.top + chartH - (v / maxY) * chartH
  const xFor = (i: number) => PADDING.left + i * stepX

  const incomingPath = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i)},${yFor(p.incoming)}`).join(' ')
  const outgoingPath = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i)},${yFor(p.outgoing)}`).join(' ')

  // Mouse-move: use the SVG's current screen-CTM to map clientX
  // back to viewBox coordinates. The previous rect-based math
  // assumed the viewBox filled the SVG DOM box linearly, but
  // `preserveAspectRatio="xMidYMid meet"` (the SVG default)
  // letterboxes the content horizontally when the container is
  // wider than the viewBox aspect — so hover snapped hundreds of
  // pixels off on wide layouts. CTM-inverse correctly accounts for
  // letterboxing, scaling, and any future transform changes.
  useEffect(() => {
    const svg = svgRef.current
    const wrap = wrapRef.current
    if (!svg || !wrap) return
    const onMove = (e: MouseEvent) => {
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const local = pt.matrixTransform(ctm.inverse())
      const xVb = local.x
      if (xVb < PADDING.left - 8 || xVb > vbW - PADDING.right + 8) {
        setHover(null)
        return
      }
      const relative = xVb - PADDING.left
      const idx = Math.max(
        0,
        Math.min(data.length - 1, Math.round(stepX === 0 ? 0 : relative / stepX)),
      )
      // Map the snapped data-point's viewBox x back to screen, then
      // subtract the wrapper's left edge — that pixel offset is what
      // the absolutely-positioned tooltip div consumes. `xFor` is
      // inlined here so the effect deps stay stable (it's a closure
      // that'd otherwise be a new reference every render).
      const dataPointVbX = PADDING.left + idx * stepX
      const dataPointPt = svg.createSVGPoint()
      dataPointPt.x = dataPointVbX
      dataPointPt.y = 0
      const screen = dataPointPt.matrixTransform(ctm)
      const wrapRect = wrap.getBoundingClientRect()
      setHover({ idx, tooltipLeftPx: screen.x - wrapRect.left })
    }
    const onLeave = () => setHover(null)
    svg.addEventListener('mousemove', onMove)
    svg.addEventListener('mouseleave', onLeave)
    return () => {
      svg.removeEventListener('mousemove', onMove)
      svg.removeEventListener('mouseleave', onLeave)
    }
    // xFor + yFor close over stepX, so stepX covers them.
  }, [data, stepX, vbW])

  const hovered = hover !== null ? data[hover.idx] : null
  const hoverX = hover !== null ? xFor(hover.idx) : 0

  // X-axis label strategy: as many evenly spaced labels as the width
  // holds (one per LABEL_SPACING px, at most 6), so a phone gets fewer
  // rather than overlapping ones.
  const labelSlots = Math.min(6, Math.max(2, Math.floor(chartW / LABEL_SPACING)))
  const labelStride = Math.max(1, Math.ceil(data.length / labelSlots))

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${vbW} ${VB_H}`}
        className="h-[240px] w-full"
        role="img"
        aria-label={t('ariaLabel')}
      >
        {/* Y-axis gridlines + labels */}
        {ticks.map((t) => {
          const y = yFor(t)
          return (
            <g key={t}>
              <line
                x1={PADDING.left}
                x2={vbW - PADDING.right}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray="3 3"
              />
              <text
                x={PADDING.left - 8}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[11px]"
              >
                {t}
              </text>
            </g>
          )
        })}

        {/* X-axis labels */}
        {data.map((p, i) =>
          i % labelStride === 0 ? (
            <text
              key={p.day}
              x={xFor(i)}
              y={VB_H - 8}
              textAnchor="middle"
              className="fill-muted-foreground text-[11px]"
            >
              {shortDayLabel(p.day)}
            </text>
          ) : null,
        )}

        {/* Outgoing polyline (neutral, dashed) */}
        <path
          d={outgoingPath}
          fill="none"
          stroke={OUTGOING}
          strokeWidth={2}
          strokeDasharray={OUTGOING_DASH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Incoming polyline (accent) */}
        <path
          d={incomingPath}
          fill="none"
          stroke={INCOMING}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Hover crosshair */}
        {hover !== null && (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
              y1={PADDING.top}
              y2={PADDING.top + chartH}
              stroke="var(--muted-foreground)"
              strokeDasharray="3 3"
            />
            <circle cx={hoverX} cy={yFor(data[hover.idx].incoming)} r={3.5} fill={INCOMING} />
            <circle cx={hoverX} cy={yFor(data[hover.idx].outgoing)} r={3.5} fill={OUTGOING} />
          </g>
        )}
      </svg>

      {/* Tooltip — absolute-positioned div so we get crisp text, not
          SVG-rendered text. The left offset comes from the CTM-based
          mapping so it lines up with the actual crosshair pixel, not a
          letterboxed viewBox percentage. */}
      {hovered && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{ left: `${hover.tooltipLeftPx}px` }}
        >
          <div className="font-medium text-popover-foreground">{longDayLabel(hovered.day)}</div>
          <div className="mt-1 flex flex-col gap-0.5 text-popover-foreground tabular-nums">
            <span className="flex items-center gap-1.5">
              <Swatch color={INCOMING} />
              {t('tooltipIncoming', { count: hovered.incoming })}
            </span>
            <span className="flex items-center gap-1.5">
              <Swatch color={OUTGOING} dash={OUTGOING_DASH} />
              {t('tooltipOutgoing', { count: hovered.outgoing })}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function Swatch({ color, dash }: { color: string; dash?: string }) {
  return (
    <svg width="16" height="4" viewBox="0 0 16 4" className="shrink-0" aria-hidden>
      <line x1="1" y1="2" x2="15" y2="2" stroke={color} strokeWidth={2} strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  )
}

function LegendLine({
  color,
  dash,
  label,
  total,
  t,
}: {
  color: string
  dash?: string
  label: string
  /** Messages in the selected range; null while it loads. */
  total: number | null
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Swatch color={color} dash={dash} />
      <span className="text-foreground">{label}</span>
      {total !== null && <span className="tabular-nums">· {t('total', { count: total.toLocaleString() })}</span>}
    </span>
  )
}

function shortDayLabel(key: string): string {
  // key is YYYY-MM-DD; return "Apr 17"-style. Using Date with an
  // appended time avoids timezone-shift surprises across midnight.
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function longDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

/**
 * Round `max` up to a "nice" number so Y-axis ticks feel natural
 * (1, 2, 5, 10, 20, 50, …). Keeps the chart readable even when the
 * series is small (max=3 becomes ceil=4, not 3).
 */
function niceCeil(max: number): number {
  if (max <= 0) return 4
  const pow = Math.pow(10, Math.floor(Math.log10(max)))
  const normalised = max / pow
  let nice: number
  if (normalised <= 1) nice = 1
  else if (normalised <= 2) nice = 2
  else if (normalised <= 5) nice = 5
  else nice = 10
  return nice * pow
}
