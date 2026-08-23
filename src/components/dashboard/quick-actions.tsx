"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap } from 'lucide-react'
import type { ComponentType } from 'react'

import { useTranslations } from 'next-intl'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page, that'd require touching those pages,
// which is out of scope here.
//
// These sit inline in the dashboard header rather than in a row of
// their own: as full-width tiles they cost 62px of height plus a gap
// to carry four words, and the header had ~1280px of empty space
// sitting right next to the title.
interface Action {
  labelKey: string
  href: string
  icon: ComponentType<{ className?: string }>
  tint: string
}

const ACTIONS: Action[] = [
  { labelKey: 'newContact', href: '/contacts', icon: UserPlus, tint: 'text-primary' },
  { labelKey: 'newDeal', href: '/pipelines', icon: Briefcase, tint: 'text-blue-400' },
  { labelKey: 'newBroadcast', href: '/broadcasts/new', icon: Radio, tint: 'text-amber-400' },
  { labelKey: 'newAutomation', href: '/automations/new', icon: Zap, tint: 'text-primary' },
]

export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')

  return (
    <div className="flex flex-wrap items-center gap-2">
      {ACTIONS.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="group inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 transition-colors hover:border-foreground/20 hover:bg-muted/60"
          >
            <Icon className={`h-[18px] w-[18px] shrink-0 ${a.tint}`} />
            <span className="text-sm font-medium whitespace-nowrap text-foreground">
              {t(a.labelKey as string)}
            </span>
          </Link>
        )
      })}
    </div>
  )
}
