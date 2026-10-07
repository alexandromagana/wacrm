"use client"

import Link from 'next/link'
import { useState } from 'react'
import {
  UserPlus,
  Briefcase,
  CircleAlert,
  Zap,
  Inbox,
  MessageSquare,
  Radio,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { ActivityItem, ActivityKind } from '@/lib/dashboard/types'
import { cn } from '@/lib/utils'
import { EmptyState, LoadError } from './empty-state'
import { Skeleton } from './skeleton'

interface ActivityFeedProps {
  items: ActivityItem[] | null
  loading: boolean
  failed: boolean
  onRetry: () => void
}

const PAGE_SIZES = [5, 10, 20, 50] as const
type PageSize = (typeof PAGE_SIZES)[number]

// The icon says what kind of thing happened; colour is kept for the
// one state that matters here — a failed automation run.
const KIND_ICON: Record<ActivityKind, ComponentType<{ className?: string }>> = {
  message: MessageSquare,
  contact: UserPlus,
  deal: Briefcase,
  broadcast: Radio,
  automation: Zap,
}

import { useTranslations } from 'next-intl'

export function ActivityFeed({ items, loading, failed, onRetry }: ActivityFeedProps) {
  const t = useTranslations('Dashboard.activityFeed')
  // Start at 5 — a quick scan of the most recent events without
  // dominating vertical real estate. User expands explicitly via the
  // footer control when they want deeper history.
  const [pageSize, setPageSize] = useState<PageSize>(5)

  const totalLoaded = items?.length ?? 0
  const visible = items?.slice(0, pageSize) ?? []
  // A size option is "useful" if picking it would reveal rows the
  // smaller option doesn't already show. With PAGE_SIZES=[5,10,20,50]:
  // "10" is useful only once we've loaded ≥6 items, "20" once ≥11, etc.
  // The smallest option is always enabled.
  const isSizeUseful = (size: PageSize, i: number) =>
    i === 0 || totalLoaded > PAGE_SIZES[i - 1]

  return (
    <section aria-labelledby="activity-title" className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h3 id="activity-title" className="text-sm font-semibold text-foreground">{t('title')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <Link
          href="/inbox"
          className="shrink-0 rounded-sm text-xs font-medium text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {t('viewAll')}
        </Link>
      </header>

      {!items && failed && !loading ? (
        <div className="p-5">
          <LoadError onRetry={onRetry} />
        </div>
      ) : !items ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={Inbox}
            title={t('noActivity')}
            hint={t('noActivityHint')}
          />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {visible.map((it) => {
              const Icon = it.failed ? CircleAlert : KIND_ICON[it.kind]
              const row = (
                <div className="flex items-center gap-3 px-5 py-2.5">
                  <Icon
                    aria-hidden
                    className={cn('size-4 shrink-0', it.failed ? 'text-danger' : 'text-muted-foreground')}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {it.failed && (
                      <span className="mr-1.5 font-medium text-danger">{t('failed')}:</span>
                    )}
                    {it.text}
                  </span>
                  <span className="flex-shrink-0 text-xs text-muted-foreground tabular-nums">
                    {relativeTime(it.at, t)}
                  </span>
                </div>
              )
              return (
                <li key={it.id} className="transition-colors hover:bg-muted/40">
                  {it.href ? (
                    <Link
                      href={it.href}
                      className="block focus-visible:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset"
                    >
                      {row}
                    </Link>
                  ) : (
                    row
                  )}
                </li>
              )
            })}
          </ul>
          <footer className="mt-auto flex items-center justify-between border-t border-border px-5 py-3 text-xs">
            <span className="text-muted-foreground tabular-nums">
              {t('showingOf', { visible: visible.length, totalLoaded, plus: totalLoaded === 50 ? '+' : '' })}
            </span>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-muted-foreground">{t('show')}</span>
              {PAGE_SIZES.map((size, i) => {
                const disabled = !isSizeUseful(size, i)
                return (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setPageSize(size)}
                    disabled={disabled}
                    aria-pressed={pageSize === size}
                    className={cn(
                      'rounded-md px-2 py-1 font-medium tabular-nums transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                      pageSize === size
                        ? 'bg-secondary text-secondary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
                    )}
                  >
                    {size}
                  </button>
                )
              })}
            </div>
          </footer>
        </>
      )}
    </section>
  )
}

function relativeTime(iso: string, t: ReturnType<typeof useTranslations>): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return t('timeS', { sec: Math.max(1, diffSec) })
  if (diffSec < 3600) return t('timeM', { min: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('timeH', { hr: Math.floor(diffSec / 3600) })
  if (diffSec < 2_592_000) return t('timeD', { day: Math.floor(diffSec / 86400) })
  return new Date(iso).toLocaleDateString()
}
