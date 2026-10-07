"use client"

import { useTranslations } from 'next-intl'
import { GitBranch } from 'lucide-react'
import type { PipelineDonutData } from '@/lib/dashboard/types'
import { formatCurrency } from '@/lib/currency'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState, LoadError } from './empty-state'
import { Skeleton } from './skeleton'

interface PipelineStagesProps {
  data: PipelineDonutData | null
  loading: boolean
  failed: boolean
  onRetry: () => void
  /** Account default currency for the totals. */
  currency: string
}

/**
 * Open value per stage as a ranked table with inline bars. It replaces
 * a donut: a ring has no scale, so stages of similar size couldn't be
 * told apart, and the numbers had to be read off a separate legend.
 */
export function PipelineStages({ data, loading, failed, onRetry, currency }: PipelineStagesProps) {
  const t = useTranslations('Dashboard.pipelineStages')
  const dealCount = data?.stages.reduce((n, s) => n + s.dealCount, 0) ?? 0
  const max = data?.stages.reduce((m, s) => Math.max(m, s.totalValue), 0) ?? 0

  return (
    <section aria-labelledby="pipeline-stages-title" className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h3 id="pipeline-stages-title" className="text-sm font-semibold text-foreground">
          {t('title')}
        </h3>
        {data && (
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description', { count: dealCount })}</p>
        )}
      </header>

      <div className="flex flex-1 flex-col p-5">
        {!data ? (
          failed && !loading ? (
            <LoadError onRetry={onRetry} />
          ) : (
            <Skeleton className="h-56 w-full" />
          )
        ) : data.stages.length === 0 ? (
          <EmptyState icon={GitBranch} title={t('noOpenDeals')} hint={t('noOpenDealsHint')} />
        ) : (
          <>
            <p className="text-2xl leading-none font-bold tracking-tight text-foreground tabular-nums">
              {formatCurrency(data.totalValue, currency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t('total')}</p>
            <Table className="mt-4">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-full pl-0 text-xs font-medium text-muted-foreground">{t('colStage')}</TableHead>
                  <TableHead className="text-right text-xs font-medium text-muted-foreground">{t('colDeals')}</TableHead>
                  <TableHead className="pr-0 text-right text-xs font-medium text-muted-foreground">{t('colValue')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.stages.map((s) => {
                  const share = data.totalValue > 0 ? Math.round((s.totalValue / data.totalValue) * 100) : 0
                  return (
                    <TableRow key={s.id} className="hover:bg-transparent">
                      <TableCell className="max-w-0 pl-0">
                        <div className="flex min-w-0 items-center gap-2">
                          {/* The stage's own colour, as set in Pipelines —
                              it ties the row to its column on the board. */}
                          <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
                          <span className="truncate text-foreground">{s.name}</span>
                        </div>
                        <div className="mt-1.5 h-1 w-full rounded-full bg-muted" title={t('share', { share })}>
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${max > 0 ? (s.totalValue / max) * 100 : 0}%` }}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="align-top text-right text-muted-foreground tabular-nums">
                        {s.dealCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="pr-0 align-top text-right text-foreground tabular-nums">
                        {formatCurrency(s.totalValue, currency)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </>
        )}
      </div>
    </section>
  )
}
