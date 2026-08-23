import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { heroValueSize } from '@/lib/stat-type'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
  /**
   * Daily history for the trend line, oldest first. Only the metrics
   * we actually store history for pass this; the rest render without
   * it rather than showing a made-up shape.
   */
  spark?: number[]
}

export function MetricCard({
  title,
  value,
  icon: Icon,
  delta,
  subtitle,
  spark,
}: MetricCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        {/* Bigger medallion than the value needs, on purpose: it anchors
         * the right edge of a card whose text only fills the left half. */}
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon className="h-[22px] w-[22px]" />
        </div>
      </div>
      {/* The number is the point of the tile, so it carries the weight.
       * The size steps down with length instead of being fixed: a flat
       * 44px fits "43" fine but pushes "MX$2,544,859" past the card's
       * ~296px content box. */}
      <p
        className={cn(
          'mt-2 leading-none font-bold tracking-tight tabular-nums text-foreground',
          heroValueSize(value),
        )}
      >
        {value}
      </p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          {delta ? (
            <DeltaRow sign={delta.sign} label={delta.label} />
          ) : subtitle ? (
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {spark && spark.length > 1 ? <Sparkline points={spark} /> : null}
      </div>
    </div>
  )
}


function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const tone =
    sign > 0
      ? 'text-primary'
      : sign < 0
      ? 'text-red-400'
      : 'text-muted-foreground'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className={cn('flex items-center gap-1 text-xs', tone)}>
      <Arrow className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate tabular-nums">{label}</span>
    </div>
  )
}

/**
 * Bare trend line for the card's dead right-hand space. Decorative, so
 * it's hidden from assistive tech: the number and delta beside it
 * already carry the same information in text.
 */
function Sparkline({ points }: { points: number[] }) {
  const W = 72
  const H = 26
  const max = Math.max(...points)
  const min = Math.min(...points)
  const span = max - min || 1
  const step = W / (points.length - 1)
  const d = points
    .map((v, i) => {
      const x = i * step
      const y = H - ((v - min) / span) * H
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className="shrink-0 overflow-visible text-primary"
      aria-hidden
      focusable="false"
    >
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
