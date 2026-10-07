"use client"

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowRight, TriangleAlert } from 'lucide-react'
import type { FollowUpSummary, MetricDelta } from '@/lib/dashboard/types'
import { LoadError } from './empty-state'
import { Skeleton } from './skeleton'

interface FollowUpsProps {
  data: FollowUpSummary | null
  loading: boolean
  failed: boolean
  onRetry: () => void
  /** New contacts today vs yesterday — from the metrics bundle, which
   *  loads separately, so it can still be on its way. */
  newContacts: MetricDelta | null
  /** The metrics bundle failed; the page's Refresh retries it. */
  newContactsFailed: boolean
}

/**
 * The second tier: counts that each need a next step but none of which
 * is a customer waiting right now. Ordered by how overdue the work is,
 * not by where the numbers come from.
 */
export function FollowUps({
  data,
  loading,
  failed,
  onRetry,
  newContacts,
  newContactsFailed,
}: FollowUpsProps) {
  const t = useTranslations('Dashboard.followUps')
  const tc = useTranslations('Dashboard.comparison')
  const tp = useTranslations('Dashboard.page')

  return (
    <section aria-labelledby="follow-ups-title">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="follow-ups-title" className="text-base font-semibold text-foreground">
          {t('title')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('description')}</p>
      </div>

      {!data && failed && !loading ? (
        <LoadError onRetry={onRetry} />
      ) : (
        // 1px gaps over a border-coloured fill draw the dividers, so the
        // strip reads as one surface rather than five more cards.
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-5">
          {!data ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="bg-card p-4 sm:last:col-span-2 lg:last:col-span-1" aria-hidden>
                <Skeleton className="h-8 w-12" />
                <Skeleton className="mt-3 h-4 w-40 max-w-full" />
                <Skeleton className="mt-2 h-3 w-32 max-w-full" />
              </div>
            ))
          ) : (
            <>
              <Indicator
                value={data.visitDoneNoInstall}
                label={t('visitDoneLabel')}
                context={t('visitDoneContext')}
                flag={data.visitDoneNoInstall > 0 ? t('overdue') : undefined}
                href="/pipelines"
                action={t('reviewPipelines')}
              />
              <Indicator
                value={data.visitsNext7 + data.installsNext7}
                label={t('scheduledLabel')}
                context={t('scheduledContext', {
                  visits: data.visitsNext7,
                  installs: data.installsNext7,
                })}
                href="/pipelines"
                action={t('reviewPipelines')}
              />
              <Indicator
                value={data.quotedOpen}
                label={t('quotedLabel')}
                context={t('quotedContext', { open: data.openDeals })}
                href="/pipelines"
                action={t('reviewPipelines')}
              />
              <Indicator
                value={data.closeSuggested}
                label={t('closeLabel')}
                context={t('closeContext')}
                href="/inbox"
                action={t('reviewInbox')}
              />
              <Indicator
                value={newContacts?.current ?? null}
                unavailable={newContactsFailed}
                label={t('newContactsLabel')}
                context={
                  newContacts ? comparison(newContacts, tc) : newContactsFailed ? tp('loadError') : ''
                }
                href="/contacts"
                action={t('seeContacts')}
              />
            </>
          )}
        </div>
      )}
    </section>
  )
}

function Indicator({
  value,
  unavailable,
  label,
  context,
  flag,
  href,
  action,
}: {
  /** Null while its source is still loading. */
  value: number | null
  /** Its source failed: show a dash, not a skeleton that never resolves. */
  unavailable?: boolean
  label: string
  context: string
  /** Short state word shown beside the value, e.g. "Overdue". */
  flag?: string
  href: string
  action: string
}) {
  return (
    <div className="flex min-w-0 flex-col bg-card p-4 sm:last:col-span-2 lg:last:col-span-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {value === null && unavailable ? (
          <span className="text-3xl leading-none font-bold text-muted-foreground">—</span>
        ) : value === null ? (
          <Skeleton className="h-8 w-12" />
        ) : (
          <span className="text-3xl leading-none font-bold tracking-tight text-foreground tabular-nums">
            {value.toLocaleString()}
          </span>
        )}
        {flag && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-warning">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            {flag}
          </span>
        )}
      </div>
      <p className="mt-2 text-sm font-medium text-foreground">{label}</p>
      {context && <p className="mt-0.5 text-xs text-muted-foreground">{context}</p>}
      <Link
        href={href}
        className="mt-auto inline-flex items-center gap-1 self-start rounded-sm pt-3 text-xs font-medium text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {action}
        <ArrowRight className="size-3" aria-hidden />
      </Link>
    </div>
  )
}

/** "3 more than yesterday (5)" — the count of what changed and the
 *  baseline, so the number never stands alone as "+3". */
export function comparison(
  delta: MetricDelta,
  t: ReturnType<typeof useTranslations>,
): string {
  const diff = delta.current - delta.previous
  const previous = delta.previous.toLocaleString()
  if (diff === 0) return t('same', { previous })
  return t(diff > 0 ? 'more' : 'fewer', { count: Math.abs(diff).toLocaleString(), previous })
}
