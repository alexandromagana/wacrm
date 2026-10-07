/**
 * Shared status badge config for conversations (open/pending/closed).
 *
 * Previously this mapping was defined independently in both
 * conversation-list.tsx (the row dot) and message-thread.tsx (the
 * status dropdown), with slightly different Tailwind shades that could
 * drift over time. One source of truth now — same pattern already
 * used for broadcasts, see broadcast-status.ts.
 *
 * Colors are intentionally fixed hues, not theme tokens (bg-primary /
 * text-primary): `open` used to follow the account's accent theme,
 * which meant it could land on the same hue as `pending`'s fixed amber
 * under the "Amber" theme — two different statuses became visually
 * indistinguishable. Fixed hues make the three statuses stay distinct
 * from each other no matter which of the 5 accent themes is active.
 * They are the shared status tokens from globals.css (success /
 * warning), which also keeps them legible on white in light mode.
 */

import type { ConversationStatus } from "@/types";

export interface ConversationStatusDisplay {
  /** Translation key suffix — pass to t(`status${labelKey}`) against
   *  the Inbox.messageThread namespace, which already carries all three. */
  labelKey: "Open" | "Pending" | "Closed";
  /** Pill treatment: tinted background + text + border, for a labeled badge. */
  classes: string;
  /** Bare text color, for the status dropdown's plain-text treatment. */
  textColor: string;
}

export const conversationStatusConfig: Record<ConversationStatus, ConversationStatusDisplay> = {
  open: {
    labelKey: "Open",
    classes: "bg-success/10 text-success border-success/20",
    textColor: "text-success",
  },
  pending: {
    labelKey: "Pending",
    classes: "bg-warning/10 text-warning border-warning/20",
    textColor: "text-warning",
  },
  closed: {
    labelKey: "Closed",
    classes: "bg-muted text-muted-foreground border-border",
    textColor: "text-muted-foreground",
  },
};

/**
 * Tolerant lookup — callers often have a generic string status coming
 * from Supabase. Falls back to `open`, matching the DB column's own
 * default, so the UI never crashes on an unknown value.
 */
export function getConversationStatus(status: string): ConversationStatusDisplay {
  return (
    conversationStatusConfig[status as ConversationStatus] ??
    conversationStatusConfig.open
  );
}
