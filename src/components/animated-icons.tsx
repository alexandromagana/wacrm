'use client'

/**
 * Animated stand-ins for the Lucide icons Animate UI also draws. Same
 * glyphs, and they take the props the CRM passes to lucide-react
 * (className, size, aria-*), so an import can move here without touching
 * the JSX. The difference: each one plays its animation while the pointer
 * is over the control that holds it — the nearest button, link, menu item
 * or tab — not just over the 16px glyph. An icon outside any control
 * listens on its parent element instead, and nothing moves for users who
 * ask for reduced motion.
 *
 * Icons Animate UI doesn't draw stay on lucide-react. To move one over
 * once it ships, `npx shadcn@latest add @animate-ui/icons-<name>` and add
 * it below. If that command offers to overwrite icons/icon.tsx, decline:
 * the base-nova style rewrites its `asChild` into `render`, which breaks
 * the file.
 */

import * as React from 'react'
import { useReducedMotion } from 'motion/react'

import type { IconProps } from '@/components/animate-ui/icons/icon'
import {
  ArrowDown as ArrowDownBase,
} from '@/components/animate-ui/icons/arrow-down'
import {
  ArrowLeft as ArrowLeftBase,
} from '@/components/animate-ui/icons/arrow-left'
import {
  ArrowRight as ArrowRightBase,
} from '@/components/animate-ui/icons/arrow-right'
import { ArrowUp as ArrowUpBase } from '@/components/animate-ui/icons/arrow-up'
import { Bell as BellBase } from '@/components/animate-ui/icons/bell'
import { Bot as BotBase } from '@/components/animate-ui/icons/bot'
import {
  ChartColumn as ChartColumnBase,
} from '@/components/animate-ui/icons/chart-column'
import { Check as CheckBase } from '@/components/animate-ui/icons/check'
import {
  CheckCheck as CheckCheckBase,
} from '@/components/animate-ui/icons/check-check'
import {
  ChevronDown as ChevronDownBase,
} from '@/components/animate-ui/icons/chevron-down'
import {
  ChevronLeft as ChevronLeftBase,
} from '@/components/animate-ui/icons/chevron-left'
import {
  ChevronRight as ChevronRightBase,
} from '@/components/animate-ui/icons/chevron-right'
import {
  ChevronUp as ChevronUpBase,
} from '@/components/animate-ui/icons/chevron-up'
import {
  CircleCheck as CircleCheckBase,
} from '@/components/animate-ui/icons/circle-check'
import {
  CircleCheckBig as CircleCheckBigBase,
} from '@/components/animate-ui/icons/circle-check-big'
import { CircleX as CircleXBase } from '@/components/animate-ui/icons/circle-x'
import { Clock as ClockBase } from '@/components/animate-ui/icons/clock'
import { Copy as CopyBase } from '@/components/animate-ui/icons/copy'
import {
  Download as DownloadBase,
} from '@/components/animate-ui/icons/download'
import {
  Ellipsis as EllipsisBase,
} from '@/components/animate-ui/icons/ellipsis'
import {
  EllipsisVertical as EllipsisVerticalBase,
} from '@/components/animate-ui/icons/ellipsis-vertical'
import {
  ExternalLink as ExternalLinkBase,
} from '@/components/animate-ui/icons/external-link'
import {
  LayoutDashboard as LayoutDashboardBase,
} from '@/components/animate-ui/icons/layout-dashboard'
import { Link as LinkBase } from '@/components/animate-ui/icons/link'
import { List as ListBase } from '@/components/animate-ui/icons/list'
import { LogOut as LogOutBase } from '@/components/animate-ui/icons/log-out'
import { MapPin as MapPinBase } from '@/components/animate-ui/icons/map-pin'
import { Menu as MenuBase } from '@/components/animate-ui/icons/menu'
import {
  MessageCircle as MessageCircleBase,
} from '@/components/animate-ui/icons/message-circle'
import {
  MessageSquare as MessageSquareBase,
} from '@/components/animate-ui/icons/message-square'
import {
  MessageSquareDashed as MessageSquareDashedBase,
} from '@/components/animate-ui/icons/message-square-dashed'
import { Moon as MoonBase } from '@/components/animate-ui/icons/moon'
import {
  MoveRight as MoveRightBase,
} from '@/components/animate-ui/icons/move-right'
import {
  PanelRightClose as PanelRightCloseBase,
} from '@/components/animate-ui/icons/panel-right-close'
import {
  PanelRightOpen as PanelRightOpenBase,
} from '@/components/animate-ui/icons/panel-right-open'
import {
  Paperclip as PaperclipBase,
} from '@/components/animate-ui/icons/paperclip'
import {
  PhoneCall as PhoneCallBase,
} from '@/components/animate-ui/icons/phone-call'
import { PlugZap as PlugZapBase } from '@/components/animate-ui/icons/plug-zap'
import { Plus as PlusBase } from '@/components/animate-ui/icons/plus'
import { Radio as RadioBase } from '@/components/animate-ui/icons/radio'
import {
  RefreshCw as RefreshCwBase,
} from '@/components/animate-ui/icons/refresh-cw'
import {
  RotateCcw as RotateCcwBase,
} from '@/components/animate-ui/icons/rotate-ccw'
import { Search as SearchBase } from '@/components/animate-ui/icons/search'
import { Send as SendBase } from '@/components/animate-ui/icons/send'
import {
  Settings as SettingsBase,
} from '@/components/animate-ui/icons/settings'
import {
  SlidersHorizontal as SlidersHorizontalBase,
} from '@/components/animate-ui/icons/sliders-horizontal'
import {
  Sparkles as SparklesBase,
} from '@/components/animate-ui/icons/sparkles'
import { Sun as SunBase } from '@/components/animate-ui/icons/sun'
import { SunMoon as SunMoonBase } from '@/components/animate-ui/icons/sun-moon'
import { Trash2 as Trash2Base } from '@/components/animate-ui/icons/trash-2'
import { Upload as UploadBase } from '@/components/animate-ui/icons/upload'
import { User as UserBase } from '@/components/animate-ui/icons/user'
import { Users as UsersBase } from '@/components/animate-ui/icons/users'
import {
  UsersRound as UsersRoundBase,
} from '@/components/animate-ui/icons/users-round'
import { Volume2 as Volume2Base } from '@/components/animate-ui/icons/volume-2'
import { X as XBase } from '@/components/animate-ui/icons/x'

/** What counts as the control an icon belongs to. */
const CONTROL_SELECTOR = [
  'a',
  'button',
  'label',
  'summary',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="option"]',
  '[role="tab"]',
  '[role^="menuitem"]',
].join(', ')

/**
 * What every animated icon accepts. The trigger and animation props are
 * left out — the trigger is always the control, and only the default
 * animation is used — which also gives all of them one shared type, the
 * way every Lucide icon is a LucideIcon.
 */
export type AnimatedIconProps = Omit<
  IconProps<string>,
  'animate' | 'animateOnHover' | 'animateOnTap' | 'animateOnView' | 'animation'
>

// lucide-react hides its icons from assistive tech unless the caller labels
// them; keeping that default makes the swap invisible to screen readers.
function hasA11yProp(props: object) {
  return Object.keys(props).some(
    (key) => key.startsWith('aria-') || key === 'role' || key === 'title',
  )
}

function animateWithControl<T extends string>(
  Icon: React.ComponentType<IconProps<T>>,
  displayName: string,
): React.FC<AnimatedIconProps> {
  function AnimatedIcon({ size = 24, ...props }: AnimatedIconProps) {
    const ref = React.useRef<SVGSVGElement>(null)
    const [hovered, setHovered] = React.useState(false)
    const reduceMotion = useReducedMotion()

    // Listens on the DOM instead of wrapping the control in <AnimateIcon>,
    // so Button, the Base UI primitives and every raw <button> keep
    // rendering exactly what they did before.
    React.useEffect(() => {
      const icon = ref.current
      const host = icon?.closest(CONTROL_SELECTOR) ?? icon?.parentElement
      if (!host) return
      const start = () => setHovered(true)
      const stop = () => setHovered(false)
      host.addEventListener('pointerenter', start)
      host.addEventListener('pointerleave', stop)
      return () => {
        host.removeEventListener('pointerenter', start)
        host.removeEventListener('pointerleave', stop)
      }
    }, [])

    const iconProps = {
      // lucide's default size; Animate UI's own is 28.
      size,
      'aria-hidden': hasA11yProp(props) ? undefined : true,
      ...props,
      ref,
    } as IconProps<T>

    return <Icon {...iconProps} animate={hovered && !reduceMotion} />
  }
  AnimatedIcon.displayName = displayName
  return AnimatedIcon
}

export const ArrowDown = animateWithControl(ArrowDownBase, 'ArrowDown')
export const ArrowLeft = animateWithControl(ArrowLeftBase, 'ArrowLeft')
export const ArrowRight = animateWithControl(ArrowRightBase, 'ArrowRight')
export const ArrowUp = animateWithControl(ArrowUpBase, 'ArrowUp')
export const Bell = animateWithControl(BellBase, 'Bell')
export const Bot = animateWithControl(BotBase, 'Bot')
export const ChartColumn = animateWithControl(ChartColumnBase, 'ChartColumn')
export const Check = animateWithControl(CheckBase, 'Check')
export const CheckCheck = animateWithControl(CheckCheckBase, 'CheckCheck')
export const ChevronDown = animateWithControl(ChevronDownBase, 'ChevronDown')
export const ChevronLeft = animateWithControl(ChevronLeftBase, 'ChevronLeft')
export const ChevronRight = animateWithControl(ChevronRightBase, 'ChevronRight')
export const ChevronUp = animateWithControl(ChevronUpBase, 'ChevronUp')
export const CircleCheck = animateWithControl(CircleCheckBase, 'CircleCheck')
export const CircleCheckBig = animateWithControl(
  CircleCheckBigBase,
  'CircleCheckBig',
)
export const CircleX = animateWithControl(CircleXBase, 'CircleX')
export const Clock = animateWithControl(ClockBase, 'Clock')
export const Copy = animateWithControl(CopyBase, 'Copy')
export const Download = animateWithControl(DownloadBase, 'Download')
export const Ellipsis = animateWithControl(EllipsisBase, 'Ellipsis')
export const EllipsisVertical = animateWithControl(
  EllipsisVerticalBase,
  'EllipsisVertical',
)
export const ExternalLink = animateWithControl(ExternalLinkBase, 'ExternalLink')
export const LayoutDashboard = animateWithControl(
  LayoutDashboardBase,
  'LayoutDashboard',
)
export const Link = animateWithControl(LinkBase, 'Link')
export const List = animateWithControl(ListBase, 'List')
export const LogOut = animateWithControl(LogOutBase, 'LogOut')
export const MapPin = animateWithControl(MapPinBase, 'MapPin')
export const Menu = animateWithControl(MenuBase, 'Menu')
export const MessageCircle = animateWithControl(
  MessageCircleBase,
  'MessageCircle',
)
export const MessageSquare = animateWithControl(
  MessageSquareBase,
  'MessageSquare',
)
export const MessageSquareDashed = animateWithControl(
  MessageSquareDashedBase,
  'MessageSquareDashed',
)
export const Moon = animateWithControl(MoonBase, 'Moon')
export const MoveRight = animateWithControl(MoveRightBase, 'MoveRight')
export const PanelRightClose = animateWithControl(
  PanelRightCloseBase,
  'PanelRightClose',
)
export const PanelRightOpen = animateWithControl(
  PanelRightOpenBase,
  'PanelRightOpen',
)
export const Paperclip = animateWithControl(PaperclipBase, 'Paperclip')
export const PhoneCall = animateWithControl(PhoneCallBase, 'PhoneCall')
export const PlugZap = animateWithControl(PlugZapBase, 'PlugZap')
export const Plus = animateWithControl(PlusBase, 'Plus')
export const Radio = animateWithControl(RadioBase, 'Radio')
export const RefreshCw = animateWithControl(RefreshCwBase, 'RefreshCw')
export const RotateCcw = animateWithControl(RotateCcwBase, 'RotateCcw')
export const Search = animateWithControl(SearchBase, 'Search')
export const Send = animateWithControl(SendBase, 'Send')
export const Settings = animateWithControl(SettingsBase, 'Settings')
export const SlidersHorizontal = animateWithControl(
  SlidersHorizontalBase,
  'SlidersHorizontal',
)
export const Sparkles = animateWithControl(SparklesBase, 'Sparkles')
export const Sun = animateWithControl(SunBase, 'Sun')
export const SunMoon = animateWithControl(SunMoonBase, 'SunMoon')
export const Trash2 = animateWithControl(Trash2Base, 'Trash2')
export const Upload = animateWithControl(UploadBase, 'Upload')
export const User = animateWithControl(UserBase, 'User')
export const Users = animateWithControl(UsersBase, 'Users')
export const UsersRound = animateWithControl(UsersRoundBase, 'UsersRound')
export const Volume2 = animateWithControl(Volume2Base, 'Volume2')
export const X = animateWithControl(XBase, 'X')

export {
  ArrowDown as ArrowDownIcon,
  ArrowLeft as ArrowLeftIcon,
  ArrowRight as ArrowRightIcon,
  ArrowUp as ArrowUpIcon,
  Bell as BellIcon,
  Bot as BotIcon,
  ChartColumn as ChartColumnIcon,
  Check as CheckIcon,
  CheckCheck as CheckCheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  ChevronUp as ChevronUpIcon,
  CircleCheck as CircleCheckIcon,
  CircleCheckBig as CircleCheckBigIcon,
  CircleX as CircleXIcon,
  Clock as ClockIcon,
  Copy as CopyIcon,
  Download as DownloadIcon,
  Ellipsis as EllipsisIcon,
  EllipsisVertical as EllipsisVerticalIcon,
  ExternalLink as ExternalLinkIcon,
  LayoutDashboard as LayoutDashboardIcon,
  Link as LinkIcon,
  List as ListIcon,
  LogOut as LogOutIcon,
  MapPin as MapPinIcon,
  Menu as MenuIcon,
  MessageCircle as MessageCircleIcon,
  MessageSquare as MessageSquareIcon,
  MessageSquareDashed as MessageSquareDashedIcon,
  Moon as MoonIcon,
  MoveRight as MoveRightIcon,
  PanelRightClose as PanelRightCloseIcon,
  PanelRightOpen as PanelRightOpenIcon,
  Paperclip as PaperclipIcon,
  PhoneCall as PhoneCallIcon,
  PlugZap as PlugZapIcon,
  Plus as PlusIcon,
  Radio as RadioIcon,
  RefreshCw as RefreshCwIcon,
  RotateCcw as RotateCcwIcon,
  Search as SearchIcon,
  Send as SendIcon,
  Settings as SettingsIcon,
  SlidersHorizontal as SlidersHorizontalIcon,
  Sparkles as SparklesIcon,
  Sun as SunIcon,
  SunMoon as SunMoonIcon,
  Trash2 as Trash2Icon,
  Upload as UploadIcon,
  User as UserIcon,
  Users as UsersIcon,
  UsersRound as UsersRoundIcon,
  Volume2 as Volume2Icon,
  X as XIcon,
}
