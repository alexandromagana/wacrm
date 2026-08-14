"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import gamaEnergiaIcon from "../../../public/gama-energia-icon.png";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { LogOut, Settings, User, UsersRound } from "lucide-react";
import {
  bottomNavItems,
  isNavItemActive,
  navItems,
  type NavItem,
} from "@/components/layout/nav-items";
import type { AccountRole } from "@/lib/auth/roles";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Desktop primary navigation: a fixed-width icon rail.
 *
 * Deliberately dark in both light and dark mode — it uses the
 * mode-invariant `--rail-*` tokens rather than `--sidebar`, so it
 * frames the content column instead of following it. Below `lg` this
 * renders nothing; mobile keeps the labelled drawer (`Sidebar`),
 * because ten unlabelled icons is a worse phone experience than the
 * drawer it would replace.
 */

/** Mirrors the drawer's role chips, minus the colour treatment there
 *  isn't room for. Explicit map rather than a built key so a renamed
 *  role fails at compile time instead of at render. */
const ROLE_LABEL_KEY: Record<AccountRole, string> = {
  owner: "roleOwner",
  admin: "roleAdmin",
  agent: "roleAgent",
  viewer: "roleViewer",
};

const RAIL_ICON_BASE =
  "relative flex size-11 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

function RailLink({
  item,
  active,
  label,
  badge,
}: {
  item: NavItem;
  active: boolean;
  label: string;
  badge?: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href={item.href}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={cn(
              RAIL_ICON_BASE,
              active
                ? "bg-primary text-primary-foreground"
                : "text-rail-muted-foreground hover:bg-rail-accent hover:text-rail-foreground",
            )}
          />
        }
      >
        <item.icon className="size-5" />
        {badge}
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

interface IconRailSidebarProps {
  /** Subscribed once in the dashboard shell and passed to both nav
   *  surfaces — see the note there on the shared realtime channels. */
  totalUnread: number;
  unreadNotifications: number;
}

export function IconRailSidebar({
  totalUnread,
  unreadNotifications,
}: IconRailSidebarProps) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const { profile, account, accountRole, signOut } = useAuth();

  return (
    <TooltipProvider>
      <aside
        aria-label="Primary"
        className="hidden w-16 shrink-0 flex-col items-center gap-1 border-r border-rail-border bg-rail py-3 lg:flex"
      >
        <Link
          href="/dashboard"
          aria-label={t("title")}
          className="mb-2 flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-rail-accent"
        >
          <Image
            src={gamaEnergiaIcon}
            alt=""
            className="size-8 object-contain"
            priority
          />
        </Link>

        <nav className="flex flex-1 flex-col items-center gap-1">
          {navItems.map((item) => {
            const active = isNavItemActive(item.href, pathname);

            // The inbox dot is a "there is something new" cue, so it
            // stands down once you're on the page. The notifications
            // count reflects unread state instead — it stays until the
            // notifications are actually marked read.
            const showUnreadDot =
              item.href === "/inbox" && totalUnread > 0 && !active;
            const showNotificationBadge =
              item.href === "/notifications" && unreadNotifications > 0;

            const label = item.beta
              ? `${t(item.labelKey as string)} · ${t("beta")}`
              : t(item.labelKey as string);

            return (
              <RailLink
                key={item.href}
                item={item}
                active={active}
                label={label}
                badge={
                  showUnreadDot ? (
                    <span
                      aria-label={t("unreadConversations", {
                        count: totalUnread,
                      })}
                      className="absolute right-2 top-2 flex size-2"
                    >
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                      <span className="relative inline-flex size-2 rounded-full bg-primary" />
                    </span>
                  ) : showNotificationBadge ? (
                    <span
                      aria-label={t("unreadNotifications", {
                        count: unreadNotifications,
                      })}
                      className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
                    >
                      {unreadNotifications > 9 ? "9+" : unreadNotifications}
                    </span>
                  ) : undefined
                }
              />
            );
          })}
        </nav>

        <div className="flex flex-col items-center gap-1">
          {bottomNavItems.map((item) => (
            <RailLink
              key={item.href}
              item={item}
              active={isNavItemActive(item.href, pathname)}
              label={t(item.labelKey as string)}
            />
          ))}

          <div className="my-1 h-px w-8 bg-rail-border" />

          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("menuProfile")}
              className="flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-rail-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 data-popup-open:bg-rail-accent"
            >
              <Avatar className="size-8">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? t("defaultAvatar")}
                  />
                ) : null}
                <AvatarFallback className="bg-primary/15 text-sm font-medium text-primary">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    "U"}
                </AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="right"
              sideOffset={8}
              className="min-w-56 bg-popover text-popover-foreground ring-border"
            >
              <div className="px-2 py-1.5">
                <p className="truncate text-sm font-medium text-foreground">
                  {profile?.full_name ?? t("defaultUser")}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {profile?.email ?? ""}
                </p>
              </div>
              {/* The rail has no room for the account strip the drawer
                  shows, so which account you're acting in — and with
                  what role — surfaces here instead. */}
              {account?.name ? (
                <div className="flex items-center gap-2 px-2 pb-1.5 text-xs text-muted-foreground">
                  <UsersRound className="size-3.5 shrink-0" />
                  <span className="truncate" title={account.name}>
                    {account.name}
                  </span>
                  {accountRole ? (
                    <span className="ml-auto shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider">
                      {t(ROLE_LABEL_KEY[accountRole])}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <User className="size-4" />
                {t("menuProfile")}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=whatsapp"
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <Settings className="size-4" />
                {t("menuSettings")}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <LogOut className="size-4" />
                {t("menuSignOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </TooltipProvider>
  );
}
