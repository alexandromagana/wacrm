"use client";

import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";

import { ModeToggle } from "@/components/layout/mode-toggle";

interface HeaderProps {
  /** Wired to the shell's drawer state. */
  onOpenSidebar?: () => void;
}

/**
 * Mobile-only control strip.
 *
 * This used to be a full app bar on every breakpoint, carrying a page
 * title, the theme toggle and an account menu. All three had somewhere
 * better to live: every page already renders its own <h1>, and both nav
 * surfaces (the icon rail on lg+, the drawer below it) already carry the
 * account menu. What was left was a second header stacked on the page's
 * own, and a title that silently fell back to "Dashboard" on any route
 * missing from its lookup table (/agents and /flows both did).
 *
 * So it's gone from lg up, where the rail covers everything, and on
 * mobile it keeps only what has no other home: the drawer trigger, plus
 * the theme toggle for reach.
 */
export function Header({ onOpenSidebar }: HeaderProps) {
  const t = useTranslations("Header");

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-2 lg:hidden">
      {/* 44x44 hit target per Apple HIG, even though the bar is 48px. */}
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label={t("openMenu")}
        className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Menu className="h-5 w-5" />
      </button>

      <ModeToggle />
    </header>
  );
}
