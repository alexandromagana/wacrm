"use client"

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { cn } from '@/lib/utils'

import {
  loadActivity,
  loadConversationsSeries,
  loadFollowUps,
  loadHealth,
  loadMetrics,
  loadPipelineDonut,
  loadReplyQueue,
  loadResponseTime,
} from '@/lib/dashboard/queries'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  FollowUpSummary,
  HealthSummary,
  MetricsBundle,
  PipelineDonutData,
  ReplyQueue as ReplyQueueData,
  ResponseTimeSummary,
} from '@/lib/dashboard/types'

import { Button } from '@/components/ui/button'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ReplyQueue } from '@/components/dashboard/reply-queue'
import { FollowUps, comparison } from '@/components/dashboard/follow-ups'
import { HealthPanel, WhatsAppAlert } from '@/components/dashboard/health-panel'
import { ConversationsChart } from '@/components/dashboard/conversations-chart'
import { PipelineStages } from '@/components/dashboard/pipeline-stages'
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart'
import { ActivityFeed } from '@/components/dashboard/activity-feed'

type RangeDays = 7 | 30 | 90

/**
 * One independently loaded block. `data` is the last good result and
 * survives a refresh, so a section never blanks back to a skeleton
 * while it reloads; `failed` lets it say so in place instead of
 * spinning forever while the rest of the page renders.
 */
interface Section<T> {
  data: T | null
  loading: boolean
  failed: boolean
}

function useSection<T>() {
  const [state, setState] = useState<Section<T>>({ data: null, loading: true, failed: false })
  // State only changes when the promise settles, so this is safe to
  // call from an effect.
  const run = useCallback((promise: Promise<T>, label: string) => {
    promise
      .then((data) => setState({ data, loading: false, failed: false }))
      .catch((err) => {
        console.error(`[dashboard] ${label} failed:`, err)
        setState((s) => ({ ...s, loading: false, failed: true }))
      })
  }, [])
  const markLoading = useCallback(() => setState((s) => ({ ...s, loading: true, failed: false })), [])
  return [state, run, markLoading] as const
}

export default function DashboardPage() {
  const t = useTranslations('Dashboard.page')
  const tTrends = useTranslations('Dashboard.trends')
  const tChart = useTranslations('Dashboard.conversationsChart')
  const tCompare = useTranslations('Dashboard.comparison')
  const { defaultCurrency, accountId, profile, profileLoading, canSendMessages, canEditSettings } =
    useAuth()

  // Ordered by the tier each block sits in, top of the page first.
  const [queue, runQueue, queueLoading] = useSection<ReplyQueueData>()
  const [health, runHealth, healthLoading] = useSection<HealthSummary>()
  const [followUps, runFollowUps, followUpsLoading] = useSection<FollowUpSummary>()
  const [metrics, runMetrics, metricsLoading] = useSection<MetricsBundle>()
  const [pipeline, runPipeline, pipelineLoading] = useSection<PipelineDonutData>()
  const [responseTime, runResponseTime, responseTimeLoading] = useSection<ResponseTimeSummary>()
  const [activity, runActivity, activityLoading] = useSection<ActivityItem[]>()

  const [range, setRange] = useState<RangeDays>(30)
  // Keep a cache per range so switching tabs doesn't re-fetch what we
  // already have. Ranges the user hasn't opened yet stay null and
  // trigger a fetch on first view.
  const [series, setSeries] = useState<Record<RangeDays, ConversationsSeriesPoint[] | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [seriesLoading, setSeriesLoading] = useState(true)
  const [seriesFailed, setSeriesFailed] = useState(false)

  // When the data on screen was asked for — the header's "Updated".
  const [updatedAt, setUpdatedAt] = useState(() => new Date())

  const fetchSeries = useCallback((r: RangeDays) => {
    loadConversationsSeries(createClient(), r)
      .then((s) => {
        setSeries((prev) => ({ ...prev, [r]: s }))
        setSeriesFailed(false)
      })
      .catch((err) => {
        console.error('[dashboard] series failed:', err)
        setSeriesFailed(true)
      })
      .finally(() => setSeriesLoading(false))
  }, [])

  const fetchQueue = useCallback(() => runQueue(loadReplyQueue(createClient()), 'reply queue'), [runQueue])
  const fetchFollowUps = useCallback(() => runFollowUps(loadFollowUps(createClient()), 'follow-ups'), [runFollowUps])
  const fetchMetrics = useCallback(() => runMetrics(loadMetrics(createClient()), 'metrics'), [runMetrics])
  const fetchPipeline = useCallback(() => runPipeline(loadPipelineDonut(createClient()), 'pipeline'), [runPipeline])
  const fetchResponseTime = useCallback(
    () => runResponseTime(loadResponseTime(createClient()), 'response time'),
    [runResponseTime],
  )
  // Fetch up to 50 so the biggest page-size option in the feed (50
  // rows) is already in memory — switching sizes is then a pure
  // client-side slice with no extra round trip.
  const fetchActivity = useCallback(() => runActivity(loadActivity(createClient(), 50), 'activity'), [runActivity])
  const fetchHealth = useCallback(
    () => runHealth(loadHealth(createClient(), accountId), 'health'),
    [runHealth, accountId],
  )

  // Kick everything off in parallel. Each block settles on its own, so
  // a slow query doesn't hold up the faster sections.
  useEffect(() => {
    fetchQueue()
    fetchFollowUps()
    fetchMetrics()
    fetchPipeline()
    fetchResponseTime()
    fetchActivity()
    fetchSeries(30)
  }, [fetchQueue, fetchFollowUps, fetchMetrics, fetchPipeline, fetchResponseTime, fetchActivity, fetchSeries])

  // WhatsApp status is read per account, so it waits for the profile.
  useEffect(() => {
    if (profileLoading) return
    fetchHealth()
  }, [profileLoading, fetchHealth])

  // Range switch handler — kept in an event callback (not an effect)
  // so the setState calls stay out of the react-hooks/set-state-in-effect
  // rule's way. The cached bucket check means switching back to a
  // previously-viewed range is instant and doesn't re-fetch.
  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r)
      if (series[r] !== null) return
      setSeriesLoading(true)
      fetchSeries(r)
    },
    [series, fetchSeries],
  )

  // Event-handler reloads: flag the block as loading, then fetch.
  const reload = (markLoading: () => void, fetch: () => void) => () => {
    markLoading()
    fetch()
  }
  const retry = {
    queue: reload(queueLoading, fetchQueue),
    health: reload(healthLoading, fetchHealth),
    followUps: reload(followUpsLoading, fetchFollowUps),
    metrics: reload(metricsLoading, fetchMetrics),
    pipeline: reload(pipelineLoading, fetchPipeline),
    responseTime: reload(responseTimeLoading, fetchResponseTime),
    activity: reload(activityLoading, fetchActivity),
    series: reload(() => setSeriesLoading(true), () => fetchSeries(range)),
  }

  function refreshAll() {
    setUpdatedAt(new Date())
    for (const run of Object.values(retry)) run()
    // Other ranges would now be older than the one on screen; drop them
    // so they refetch when opened.
    setSeries((prev) => ({ 7: null, 30: null, 90: null, [range]: prev[range] }))
  }

  const refreshing =
    queue.loading ||
    health.loading ||
    followUps.loading ||
    metrics.loading ||
    pipeline.loading ||
    responseTime.loading ||
    activity.loading ||
    seriesLoading

  const sentToday = metrics.data?.messagesSentToday
  const todayNote = sentToday
    ? tChart('sentToday', { count: sentToday.current, comparison: comparison(sentToday, tCompare) })
    : undefined

  const date = updatedAt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const time = updatedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const period = dayPeriod(updatedAt)
  const firstName = profile?.full_name?.trim().split(/\s+/)[0]

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          {/* The greeting is the headline; what the page is, for when
              and for whom, sits right under it. */}
          <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            {firstName ? t('greetingNamed', { period, name: firstName }) : t('greeting', { period })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('scope', { title: t('title'), date })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {t('updatedAt', { time })}
          </span>
          <Button variant="ghost" size="lg" onClick={refreshAll} disabled={refreshing}>
            <RefreshCw aria-hidden className={cn(refreshing && 'motion-safe:animate-spin')} />
            {t('refresh')}
          </Button>
          <QuickActions />
        </div>
      </header>

      {health.data?.whatsapp === 'disconnected' && <WhatsAppAlert canFix={canEditSettings} />}

      {/* Tier 1 — the customers waiting right now. */}
      <ReplyQueue
        data={queue.data}
        loading={queue.loading}
        failed={queue.failed}
        onRetry={retry.queue}
        canReply={canSendMessages}
      />

      {/* Tier 2 — next steps that are due but not on fire. */}
      <FollowUps
        data={followUps.data}
        loading={followUps.loading}
        failed={followUps.failed}
        onRetry={retry.followUps}
        newContacts={metrics.data?.newContactsToday ?? null}
        newContactsFailed={!metrics.data && metrics.failed && !metrics.loading}
      />

      {/* Tier 3 — history and context. */}
      <section aria-labelledby="trends-title" className="space-y-4 pt-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="trends-title" className="text-base font-semibold text-foreground">
            {tTrends('title')}
          </h2>
          <p className="text-xs text-muted-foreground">{tTrends('description')}</p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <div className="h-full lg:col-span-3">
            <ConversationsChart
              series={series}
              loading={seriesLoading}
              failed={seriesFailed}
              onRetry={retry.series}
              range={range}
              onRangeChange={handleRangeChange}
              todayNote={todayNote}
            />
          </div>
          <div className="h-full lg:col-span-2">
            <PipelineStages
              data={pipeline.data}
              loading={pipeline.loading}
              failed={pipeline.failed}
              onRetry={retry.pipeline}
              currency={defaultCurrency}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ResponseTimeChart
            data={responseTime.data}
            loading={responseTime.loading}
            failed={responseTime.failed}
            onRetry={retry.responseTime}
          />
          <ActivityFeed
            items={activity.data}
            loading={activity.loading}
            failed={activity.failed}
            onRetry={retry.activity}
          />
        </div>
      </section>

      {/* At the foot: the per-line states and its red border say when
          something broke; the WhatsApp-disconnected alert, the one
          failure that stops everything, still sits at the top. */}
      <HealthPanel data={health.data} loading={health.loading} failed={health.failed} onRetry={retry.health} />
    </div>
  )
}

/** Greeting period from the local hour the data was asked for. */
function dayPeriod(at: Date): 'morning' | 'afternoon' | 'evening' {
  const hour = at.getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 19) return 'afternoon'
  return 'evening'
}
