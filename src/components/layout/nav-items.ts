import {
  Bell,
  Bot,
  Calculator,
  GitBranch,
  LayoutDashboard,
  MessageSquare,
  Radio,
  Settings,
  Users,
  Workflow,
  Zap,
} from "lucide-react";

/**
 * The primary navigation catalog, shared by the two nav surfaces:
 * `IconRailSidebar` (desktop) and `Sidebar` (mobile drawer). Kept in
 * its own module so adding a section is a one-line change that both
 * surfaces pick up, rather than two lists drifting apart.
 *
 * `labelKey` resolves against the `Sidebar` message namespace.
 */
export interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label
   * (the rail, having no room for one, folds it into the tooltip).
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
}

export const navItems: NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
  { href: "/inbox", labelKey: "inbox", icon: MessageSquare },
  { href: "/notifications", labelKey: "notifications", icon: Bell },
  { href: "/contacts", labelKey: "contacts", icon: Users },
  { href: "/pipelines", labelKey: "pipelines", icon: GitBranch },
  { href: "/broadcasts", labelKey: "broadcasts", icon: Radio },
  { href: "/automations", labelKey: "automations", icon: Zap },
  { href: "/flows", labelKey: "flows", icon: Workflow, beta: true },
  { href: "/agents", labelKey: "aiAgents", icon: Bot },
  { href: "/quotes", labelKey: "quotes", icon: Calculator },
];

export const bottomNavItems: NavItem[] = [
  { href: "/settings", labelKey: "settings", icon: Settings },
];

/**
 * Active-section test shared by both nav surfaces so the highlight
 * can't disagree between them. `/dashboard` is exact-match only —
 * every other route would otherwise stay lit on its own subpages.
 */
export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
