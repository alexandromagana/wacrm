import { CircleAlert } from 'lucide-react'
import { ChartColumn } from '@/components/animated-icons'
import type { ComponentType } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { useTranslations } from 'next-intl'

/**
 * Shared empty-state panel for charts that can't render meaningfully
 * without a minimum amount of data. Kept minimal and uniform so the
 * three empty states on the dashboard don't each feel like a
 * different widget.
 */
export function EmptyState({
  title,
  hint,
  icon: Icon = ChartColumn,
  className,
}: {
  title?: string
  hint?: string
  icon?: ComponentType<{ className?: string }>
  className?: string
}) {
  const t = useTranslations('Dashboard.emptyState')
  const defaultTitle = t('title')
  
  return (
    <div
      className={cn(
        'flex h-full min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card/40 px-4 py-6 text-center',
        className,
      )}
    >
      <Icon className="h-5 w-5 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">{title || defaultTitle}</p>
      {hint && <p className="max-w-xs text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * A section whose query failed. Every dashboard block loads on its
 * own, so one failure says so in place (with a retry) instead of
 * leaving that block on a skeleton forever while the rest render.
 */
export function LoadError({ onRetry, className }: { onRetry?: () => void; className?: string }) {
  const t = useTranslations('Dashboard.page')
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-foreground',
        className,
      )}
    >
      <CircleAlert className="size-4 shrink-0 text-danger" aria-hidden />
      <span className="min-w-0 flex-1">{t('loadError')}</span>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('retry')}
        </Button>
      )}
    </div>
  )
}
