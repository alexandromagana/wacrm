"use client"

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowRight, CircleAlert, CircleCheck, CircleHelp, WifiOff } from 'lucide-react'
import type { FailedSend, FailingAutomation, HealthSummary } from '@/lib/dashboard/types'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { LoadError } from './empty-state'
import { Skeleton } from './skeleton'

/** Anything here that someone has to go and fix. */
export function hasIncidents(h: HealthSummary | null): boolean {
  if (!h) return false
  return (
    h.whatsapp === 'disconnected' || h.failedSends > 0 || h.failedRuns > 0 || h.failedBroadcasts > 0
  )
}

/**
 * Full-width alert for the one state that stops everything: with
 * WhatsApp disconnected nothing the rest of the page asks for can be
 * done, so it sits above the queue rather than inside the health list.
 */
export function WhatsAppAlert({ canFix }: { canFix: boolean }) {
  const t = useTranslations('Dashboard.health')
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-danger/40 bg-danger/10 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <WifiOff className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{t('disconnectedTitle')}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {canFix ? t('disconnectedBody') : t('disconnectedBodyAskAdmin')}
          </p>
        </div>
      </div>
      {canFix && (
        <Link
          href="/settings?tab=whatsapp"
          className={cn(buttonVariants({ variant: 'outline' }), 'shrink-0 self-start sm:self-center')}
        >
          {t('openSettings')}
        </Link>
      )}
    </div>
  )
}

interface HealthPanelProps {
  data: HealthSummary | null
  loading: boolean
  failed: boolean
  onRetry: () => void
}

/**
 * Delivery and automation failures over the last 7 days, at the foot
 * of the page. When something failed, the lines below the summary name
 * each failure and link to where it happened — a bare count sent
 * people to the inbox with no way to find the message.
 */
export function HealthPanel({ data, loading, failed, onRetry }: HealthPanelProps) {
  const t = useTranslations('Dashboard.health')
  const incidents = hasIncidents(data)

  return (
    <section
      aria-labelledby="health-title"
      className={cn(
        'rounded-xl border bg-card px-5 py-4',
        incidents ? 'border-danger/40' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="health-title" className="text-sm font-semibold text-foreground">
          {incidents ? t('incidentsTitle') : t('title')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('period')}</p>
      </div>

      {!data ? (
        failed && !loading ? (
          <LoadError onRetry={onRetry} className="mt-3" />
        ) : (
          <div className="mt-3 flex flex-wrap gap-4" aria-hidden>
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-48" />
          </div>
        )
      ) : (
        <ul className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <HealthLine
            state={data.whatsapp === 'connected' ? 'ok' : data.whatsapp === 'disconnected' ? 'bad' : 'unknown'}
            text={
              data.whatsapp === 'connected'
                ? t('whatsappConnected')
                : data.whatsapp === 'disconnected'
                  ? t('whatsappDisconnected')
                  : t('whatsappUnknown')
            }
          />
          <HealthLine
            state={data.failedSends > 0 ? 'bad' : 'ok'}
            text={t('failedSends', {
              failed: data.failedSends.toLocaleString(),
              total: data.outboundMessages.toLocaleString(),
            })}
          />
          <HealthLine
            state={data.failedRuns > 0 ? 'bad' : 'ok'}
            text={t('failedRuns', {
              failed: data.failedRuns.toLocaleString(),
              total: data.totalRuns.toLocaleString(),
            })}
          />
          <HealthLine
            state={data.failedBroadcasts > 0 ? 'bad' : 'ok'}
            text={t('failedBroadcasts', { count: data.failedBroadcasts })}
            href={data.failedBroadcasts > 0 ? '/broadcasts' : undefined}
            action={t('reviewBroadcasts')}
          />
        </ul>
      )}

      {data && data.recentFailedSends.length > 0 && (
        <FailedSendList items={data.recentFailedSends} total={data.failedSends} />
      )}
      {data && data.failingAutomations.length > 0 && (
        <FailingAutomationList items={data.failingAutomations} />
      )}
    </section>
  )
}

function FailedSendList({ items, total }: { items: FailedSend[]; total: number }) {
  const t = useTranslations('Dashboard.health')
  return (
    <div className="mt-4 border-t border-border pt-3">
      <h3 className="text-xs font-medium text-muted-foreground">{t('failedSendsTitle')}</h3>
      <ul className="mt-1 divide-y divide-border">
        {items.map((f) => {
          const name = f.contactName || t('unknownContact')
          return (
            <li key={f.messageId} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:gap-4">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 text-sm">
                  <CircleAlert className="size-4 shrink-0 text-danger" aria-hidden />
                  <span className="font-medium text-foreground">{name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {f.contentType === 'template' ? t('typeTemplate') : t('typeMessage')} ·{' '}
                    <time dateTime={f.at}>
                      {new Date(f.at).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </span>
                </p>
                {/* Meta's own wording, kept whole (two lines at most)
                    rather than cut behind a hover. */}
                <p className="mt-0.5 line-clamp-2 pl-6 text-xs text-muted-foreground">
                  {f.reason || t('noReason')}
                </p>
              </div>
              <Link
                href={`/inbox?c=${f.conversationId}`}
                aria-label={t('openConversationWith', { name })}
                className="inline-flex shrink-0 items-center gap-1 self-start rounded-sm pl-6 text-xs font-medium whitespace-nowrap text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:pl-0"
              >
                {t('openConversation')}
                <ArrowRight className="size-3" aria-hidden />
              </Link>
            </li>
          )
        })}
      </ul>
      {total > items.length && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('moreFailedSends', { shown: items.length, total })}
        </p>
      )}
    </div>
  )
}

function FailingAutomationList({ items }: { items: FailingAutomation[] }) {
  const t = useTranslations('Dashboard.health')
  return (
    <div className="mt-4 border-t border-border pt-3">
      <h3 className="text-xs font-medium text-muted-foreground">{t('failingAutomationsTitle')}</h3>
      <ul className="mt-1 divide-y divide-border">
        {items.map((a) => {
          const name = a.name || t('unnamedAutomation')
          return (
            <li key={a.automationId} className="flex items-center gap-3 py-2.5 text-sm">
              <CircleAlert className="size-4 shrink-0 text-danger" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">{name}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {t('automationFailures', { count: a.failedRuns })}
              </span>
              <Link
                href={`/automations/${a.automationId}/logs`}
                aria-label={t('viewLogsFor', { name })}
                className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs font-medium whitespace-nowrap text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {t('viewLogs')}
                <ArrowRight className="size-3" aria-hidden />
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function HealthLine({
  state,
  text,
  href,
  action,
}: {
  state: 'ok' | 'bad' | 'unknown'
  text: string
  href?: string
  action?: string
}) {
  const Icon = state === 'ok' ? CircleCheck : state === 'bad' ? CircleAlert : CircleHelp
  return (
    <li className="flex min-w-0 items-start gap-2">
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          state === 'ok' ? 'text-success' : state === 'bad' ? 'text-danger' : 'text-muted-foreground',
        )}
      />
      <span className="min-w-0">
        <span className={cn('tabular-nums', state === 'bad' ? 'font-medium text-foreground' : 'text-muted-foreground')}>
          {text}
        </span>
        {href && action && (
          <Link
            href={href}
            className="ml-2 inline-flex items-center gap-1 rounded-sm text-xs font-medium whitespace-nowrap text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {action}
            <ArrowRight className="size-3" aria-hidden />
          </Link>
        )}
      </span>
    </li>
  )
}
