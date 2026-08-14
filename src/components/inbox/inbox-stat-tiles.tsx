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

export type StatTileFilter = "all" | "unread" | "open" | "pending";

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
    let unread = 0;
    let open = 0;
    let pending = 0;
    for (const c of conversations) {
      if (c.unread_count > 0) unread += 1;
      if (c.status === "open") open += 1;
      else if (c.status === "pending") pending += 1;
    }
    return { all: conversations.length, unread, open, pending };
  }, [conversations]);

  const tiles: { key: StatTileFilter; dot: string }[] = [
    { key: "all", dot: "bg-muted-foreground" },
    { key: "unread", dot: "bg-primary" },
    { key: "open", dot: "bg-sky-400" },
    { key: "pending", dot: "bg-amber-400" },
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
              "rounded-lg border px-2 py-1.5 text-left transition-colors",
              selected
                ? "border-primary/50 bg-primary/10"
                : "border-border bg-card-2 hover:bg-muted",
            )}
          >
            <span className="flex items-center gap-1">
              <span
                className={cn("size-1.5 shrink-0 rounded-full", tile.dot)}
                aria-hidden
              />
              <span className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {labels[tile.key]}
              </span>
            </span>
            <span
              className={cn(
                "mt-0.5 block text-base font-semibold leading-none",
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
