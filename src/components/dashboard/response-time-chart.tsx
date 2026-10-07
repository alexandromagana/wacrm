"use client"

import { Clock } from '@/components/animated-icons'
import { DOW_SHORT_MON_FIRST } from '@/lib/dashboard/date-utils'
import type { ResponseTimeSummary } from '@/lib/dashboard/types'
import { BarChart } from '@/components/tremor/bar-chart'
import { EmptyState, LoadError } from './empty-state'
import { Skeleton } from './skeleton'

interface ResponseTimeChartProps {
  data: ResponseTimeSummary | null
  loading: boolean
  failed: boolean
  onRetry: () => void
}

import { useTranslations } from 'next-intl'

// Single category, single colour — the data is "average minutes
// per weekday". Tremor expects categories as the second tuple in
// the row object, so we shape the buckets into
// `{ day: 'Mon', 'Avg minutes': 4.2 }` rows below.
const CATEGORY = 'Avg minutes'

// No response-time target is drawn: the account has no SLA setting,
// and a hard-coded one would read as policy nobody agreed to.
export function ResponseTimeChart({ data, loading, failed, onRetry }: ResponseTimeChartProps) {
  const t = useTranslations('Dashboard.responseTimeChart')
  const hasData = data?.buckets.some((b) => b.avgMinutes != null) ?? false

  // Map buckets → Tremor rows. Null `avgMinutes` (no samples)
  // collapses to 0; the chart will render an empty slot for it.
  // We attach `samples` on the row so a future customTooltip can
  // surface "no samples" copy without losing the data shape.
  const chartData =
    data?.buckets.map((b, i) => ({
      day: DOW_SHORT_MON_FIRST[i],
      [CATEGORY]: b.avgMinutes ?? 0,
      samples: b.samples,
    })) ?? []

  return (
    <section aria-labelledby="response-time-title" className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 max-w-md">
          <h3 id="response-time-title" className="text-sm font-semibold text-foreground">
            {t('title')}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('description')}
          </p>
        </div>
        {data && (data.thisWeekAvg != null || data.lastWeekAvg != null) && (
          // Right-aligned only beside the title; once the header wraps
          // it sits under the title and aligns with it.
          <div className="text-xs tabular-nums lg:text-right">
            <div className="font-medium text-foreground">
              {t('thisWeek', { value: fmt(data.thisWeekAvg) })}
            </div>
            <div className="text-muted-foreground">
              {t('lastWeek', { value: fmt(data.lastWeekAvg) })}
            </div>
          </div>
        )}
      </header>

      <div className="p-5">
        {!data && failed && !loading ? (
          <LoadError onRetry={onRetry} />
        ) : !data ? (
          <Skeleton className="h-[260px] w-full" />
        ) : !hasData ? (
          <EmptyState
            icon={Clock}
            title={t('noReplies')}
            hint={t('noRepliesHint')}
          />
        ) : (
          <BarChart
            data={chartData}
            index="day"
            categories={[CATEGORY]}
            colors={['primary']}
            // Shared by the axis and the tooltip: whole minutes once the
            // number is big enough that a decimal is noise.
            valueFormatter={(value) =>
              `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} min`
            }
            showLegend={false}
            yAxisWidth={76}
            // Compact height so the chart sits well inside the card
            // without dominating the row alongside the donut + activity feed.
            className="h-[260px]"
          />
        )}
      </div>
    </section>
  )
}

function fmt(mins: number | null): string {
  if (mins == null) return '—'
  if (mins < 1) return `${Math.max(1, Math.round(mins * 60))} s`
  if (mins < 60) return `${mins.toFixed(1)} min`
  return `${(mins / 60).toFixed(1)} h`
}
