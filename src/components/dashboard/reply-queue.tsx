"use client"

import Link from 'next/link'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { CircleCheck, Clock, FileText } from 'lucide-react'
import type { ReplyQueue as ReplyQueueData, ReplyQueueItem } from '@/lib/dashboard/types'
import { buttonVariants } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { LoadError } from './empty-state'
import { Skeleton } from './skeleton'

interface ReplyQueueProps {
  data: ReplyQueueData | null
  loading: boolean
  failed: boolean
  onRetry: () => void
  /** Viewers can open a thread but not answer it. */
  canReply: boolean
}

/** Rows shown before "Show all"; enough to act on without a scroll. */
const PREVIEW_ROWS = 5
/** Past this the inbox, with its search and filters, is the better tool. */
const MAX_ROWS = 50

/**
 * The dashboard's primary block: conversations where the customer
 * spoke last and nobody has answered. It is the one number on the page
 * that maps straight to an action, so it gets the size and the top slot.
 */
export function ReplyQueue({ data, loading, failed, onRetry, canReply }: ReplyQueueProps) {
  const t = useTranslations('Dashboard.replyQueue')
  const [expanded, setExpanded] = useState(false)

  if (!data) {
    return (
      <section aria-labelledby="reply-queue-title" className="rounded-xl border border-border bg-card p-5 sm:p-6">
        <h2 id="reply-queue-title" className="text-xl leading-tight font-semibold text-foreground sm:text-2xl">
          {t('loadingTitle')}
        </h2>
        {failed && !loading ? (
          <LoadError onRetry={onRetry} className="mt-4" />
        ) : (
          <div className="mt-4 space-y-3" aria-hidden>
            <Skeleton className="h-10 w-72 max-w-full" />
            <Skeleton className="h-4 w-96 max-w-full" />
            <Skeleton className="mt-6 h-40 w-full" />
          </div>
        )}
      </section>
    )
  }

  const { items, activeCount, agentNames } = data
  const waiting = items.length
  const inWindow = items.filter((i) => i.hoursLeft !== null).length
  const handedOff = items.filter((i) => i.handedOff).length
  const unassigned = items.filter((i) => !i.assignedAgentId).length
  const limit = expanded ? MAX_ROWS : PREVIEW_ROWS
  const visible = items.slice(0, limit)

  return (
    <section aria-labelledby="reply-queue-title" className="rounded-xl border border-border bg-card">
      <div className="flex flex-col gap-4 p-5 sm:p-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2
            id="reply-queue-title"
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xl leading-tight font-semibold text-foreground sm:text-2xl"
          >
            {waiting === 0 && (
              <CircleCheck className="size-6 shrink-0 self-center text-success" aria-hidden />
            )}
            {t.rich('headline', {
              count: waiting,
              n: (chunks) => (
                <span className="text-5xl leading-none font-bold tracking-tight tabular-nums">
                  {chunks}
                </span>
              ),
            })}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {waiting === 0 ? t('emptyHint') : t('definition')}{' '}
            <span className="whitespace-nowrap tabular-nums">
              {t('universe', { waiting, active: activeCount })}.
            </span>
          </p>
          {waiting > 0 && (
            <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-foreground">
              <Fact tone="success">{t('inWindow', { count: inWindow })}</Fact>
              <Fact tone="warning">{t('needTemplate', { count: waiting - inWindow })}</Fact>
              {handedOff > 0 && <Fact>{t('handedOff', { count: handedOff })}</Fact>}
              {unassigned > 0 && <Fact>{t('unassigned', { count: unassigned })}</Fact>}
            </ul>
          )}
        </div>
        <Link href="/inbox" className={cn(buttonVariants({ size: 'lg' }), 'self-start px-3.5')}>
          {t('openInbox')}
        </Link>
      </div>

      {waiting > 0 && (
        <>
          <Table className="border-t border-border">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5 text-xs font-medium text-muted-foreground sm:pl-6">
                  {t('colContact')}
                </TableHead>
                <TableHead className="hidden text-xs font-medium text-muted-foreground md:table-cell">
                  {t('colMessage')}
                </TableHead>
                <TableHead className="text-right text-xs font-medium text-muted-foreground">
                  {t('colWaiting')}
                </TableHead>
                <TableHead className="hidden text-xs font-medium text-muted-foreground sm:table-cell">
                  {t('colWindow')}
                </TableHead>
                <TableHead className="hidden text-xs font-medium text-muted-foreground lg:table-cell">
                  {t('colOwner')}
                </TableHead>
                <TableHead className="pr-5 sm:pr-6">
                  <span className="sr-only">{canReply ? t('reply') : t('open')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((item) => (
                <QueueRow
                  key={item.conversationId}
                  item={item}
                  owner={
                    item.assignedAgentId
                      ? (agentNames[item.assignedAgentId] ?? t('assignedOwner'))
                      : null
                  }
                  canReply={canReply}
                />
              ))}
            </TableBody>
          </Table>
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 text-xs text-muted-foreground sm:px-6">
            <span>
              {expanded && waiting > MAX_ROWS
                ? t('capped', { shown: MAX_ROWS, total: waiting })
                : t('sortNote')}
            </span>
            {waiting > PREVIEW_ROWS && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="rounded-md px-2 py-1 font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {expanded ? t('showLess', { count: PREVIEW_ROWS }) : t('showAll', { count: waiting })}
              </button>
            )}
          </footer>
        </>
      )}
    </section>
  )
}

function Fact({ tone, children }: { tone?: 'success' | 'warning'; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0 rounded-full',
          tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-muted-foreground/60',
        )}
      />
      <span className="tabular-nums">{children}</span>
    </li>
  )
}

function QueueRow({
  item,
  owner,
  canReply,
}: {
  item: ReplyQueueItem
  owner: string | null
  canReply: boolean
}) {
  const t = useTranslations('Dashboard.replyQueue')
  const name = item.contactName || t('unknownContact')
  const href = `/inbox?c=${item.conversationId}`

  return (
    <TableRow>
      <TableCell className="max-w-0 pl-5 sm:pl-6 md:w-[22%]">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={href}
            className="truncate rounded-sm font-medium text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {name}
          </Link>
          {item.handedOff && (
            <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[11px] font-medium text-muted-foreground">
              {t('handoffTag')}
            </span>
          )}
        </div>
        {/* The window column drops off on phones; its state moves
            under the name so status still sits next to the action. */}
        <div className="mt-0.5 sm:hidden">
          <WindowState hoursLeft={item.hoursLeft} />
        </div>
      </TableCell>
      <TableCell className="hidden max-w-0 text-muted-foreground md:table-cell">
        <span className="block truncate">{item.preview || t('noMessageText')}</span>
      </TableCell>
      <TableCell className="text-right tabular-nums text-foreground">
        <time dateTime={item.customerAt} title={new Date(item.customerAt).toLocaleString()}>
          {waitedLabel(item.customerAt, t)}
        </time>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <WindowState hoursLeft={item.hoursLeft} />
      </TableCell>
      <TableCell className="hidden max-w-40 lg:table-cell">
        <span className={cn('block truncate', owner ? 'text-foreground' : 'text-muted-foreground')}>
          {owner ?? t('unassignedOwner')}
        </span>
      </TableCell>
      <TableCell className="w-px pr-5 text-right sm:pr-6">
        <Link
          href={href}
          aria-label={canReply ? t('replyTo', { name }) : t('openConversation', { name })}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {canReply ? t('reply') : t('open')}
        </Link>
      </TableCell>
    </TableRow>
  )
}

/** Same reading as the inbox list: green while a free-form reply can
 *  still go out, amber once only a template will. */
function WindowState({ hoursLeft }: { hoursLeft: number | null }) {
  const t = useTranslations('Dashboard.replyQueue')
  if (hoursLeft === null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-warning" title={t('templateOnlyHint')}>
        <FileText className="size-3.5 shrink-0" aria-hidden />
        {t('templateOnly')}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-success tabular-nums">
      <Clock className="size-3.5 shrink-0" aria-hidden />
      {t('hoursLeft', { hours: hoursLeft })}
    </span>
  )
}

function waitedLabel(iso: string, t: ReturnType<typeof useTranslations>): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000))
  if (minutes < 60) return t('waitedMinutes', { n: Math.max(1, minutes) })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('waitedHours', { n: hours })
  return t('waitedDays', { n: Math.floor(hours / 24) })
}
