"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types";

/**
 * The count tiles above the conversation list.
 *
 * They double as filter shortcuts rather than being read-only chrome:
 * each tile selects the filter it counts, and the currently selected
 * one is marked. Counts come from the full conversation list, not the
 * filtered view, so they don't change as you narrow the list down.
 */

/**
 * `active` is open + pending (the inbox default); `suggested` counts the
 * chats the lifecycle sweep flagged as ready to close.
 */
export type StatTileFilter = "active" | "unread" | "pending" | "suggested";

interface InboxStatTilesProps {
  conversations: Conversation[];
  active: string;
  onSelect: (filter: StatTileFilter) => void;
  labels: Record<StatTileFilter, string>;
}

export function InboxStatTiles({
  conversations,
  active,
  onSelect,
  labels,
}: InboxStatTilesProps) {
  const counts = useMemo(() => {
    let active = 0;
    let unread = 0;
    let pending = 0;
    let suggested = 0;
    for (const c of conversations) {
      if (c.unread_count > 0) unread += 1;
      if (c.status === "closed") continue;
      active += 1;
      if (c.status === "pending") pending += 1;
      if (c.close_suggested_at) suggested += 1;
    }
    return { active, unread, pending, suggested };
  }, [conversations]);

  // Colour only where the count is a state: unread is the accent (it
  // is the one to act on), pending is waiting (warning). Active and
  // stale are plain totals.
  const tiles: { key: StatTileFilter; dot: string }[] = [
    { key: "active", dot: "bg-muted-foreground" },
    { key: "unread", dot: "bg-primary" },
    { key: "pending", dot: "bg-warning" },
    { key: "suggested", dot: "bg-muted-foreground" },
  ];

  return (
    <div className="grid grid-cols-4 gap-1.5">
      {tiles.map((tile) => {
        const selected = active === tile.key;
        return (
          <button
            key={tile.key}
            type="button"
            onClick={() => onSelect(tile.key)}
            aria-pressed={selected}
            className={cn(
              "rounded-lg border px-2 py-1 text-left transition-colors lg:py-1.5",
              selected
                ? "border-primary/50 bg-primary/10"
                : "border-border bg-card hover:bg-muted",
            )}
          >
            <span className="flex items-center gap-1">
              <span
                className={cn("size-1.5 shrink-0 rounded-full", tile.dot)}
                aria-hidden
              />
              <span
                className={cn(
                  "truncate text-[11px] font-medium uppercase tracking-wide",
                  // On the accent tint the muted grey fell to 4.4:1.
                  selected ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {labels[tile.key]}
              </span>
            </span>
            <span
              className={cn(
                "mt-0.5 block text-xl font-bold leading-none tabular-nums tracking-tight lg:mt-1",
                selected ? "text-primary" : "text-foreground",
              )}
            >
              {counts[tile.key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
