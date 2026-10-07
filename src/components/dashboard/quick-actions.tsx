"use client"

import { useRouter } from 'next/navigation'
import { Briefcase, ChevronDown, Plus, Radio, UserPlus, Zap } from 'lucide-react'
import type { ComponentType } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { useTranslations } from 'next-intl'

// Shortcuts to the page that owns each "create" flow. We deliberately
// don't try to auto-open any modal on the target page — that would mean
// touching those pages, which is out of scope here.
//
// They live behind one "Create" menu: none of them is what the
// dashboard is opened for, so four buttons in the header competed with
// the queue for attention without being the next thing to do.
interface Action {
  labelKey: string
  href: string
  icon: ComponentType<{ className?: string }>
}

const ACTIONS: Action[] = [
  { labelKey: 'newContact', href: '/contacts', icon: UserPlus },
  { labelKey: 'newDeal', href: '/pipelines', icon: Briefcase },
  { labelKey: 'newBroadcast', href: '/broadcasts/new', icon: Radio },
  { labelKey: 'newAutomation', href: '/automations/new', icon: Zap },
]

export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')
  const tp = useTranslations('Dashboard.page')
  const router = useRouter()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="lg" />}>
        <Plus aria-hidden />
        {tp('create')}
        <ChevronDown className="text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-44">
        {ACTIONS.map((a) => {
          const Icon = a.icon
          return (
            <DropdownMenuItem key={a.href} onClick={() => router.push(a.href)}>
              <Icon className="h-4 w-4" />
              {t(a.labelKey as string)}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
