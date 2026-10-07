/**
 * Shared status badge config for broadcasts + recipients.
 *
 * Previously `statusConfig` was defined inline in both
 * /broadcasts/page.tsx and /broadcasts/[id]/page.tsx with slight
 * drift risk. One source of truth now.
 *
 * Badge shape: a /10 tint + text + /20 border of one token. Only the
 * outcomes get a status colour — sent / replied (success) and failed
 * (danger); in-flight states are the accent, and the steps in between
 * (scheduled, sent, delivered, read) stay neutral, since none of them
 * is good or bad on its own.
 */

import type { BroadcastStatus, RecipientStatus } from "@/types";

export interface StatusDisplay {
  label: string;
  classes: string;
  /**
   * Set true for statuses that should pulse in the UI to convey
   * "live / in-flight" — currently only `sending`.
   */
  pulse?: boolean;
}

export const broadcastStatusConfig: Record<BroadcastStatus, StatusDisplay> = {
  draft: {
    label: "draft",
    classes: "bg-muted text-muted-foreground border-border",
  },
  scheduled: {
    label: "scheduled",
    classes: "bg-transparent text-foreground border-border",
  },
  sending: {
    label: "sending",
    classes: "bg-primary/10 text-primary border-primary/20",
    pulse: true,
  },
  sent: {
    label: "sent",
    classes: "bg-success/10 text-success border-success/20",
  },
  failed: {
    label: "failed",
    classes: "bg-danger/10 text-danger border-danger/20",
  },
};

export const recipientStatusConfig: Record<RecipientStatus, StatusDisplay> = {
  pending: {
    label: "pending",
    classes: "bg-muted text-muted-foreground border-border",
  },
  sent: {
    label: "sent",
    classes: "bg-transparent text-foreground border-border",
  },
  delivered: {
    label: "delivered",
    classes: "bg-transparent text-foreground border-border",
  },
  read: {
    label: "read",
    classes: "bg-transparent text-foreground border-border",
  },
  replied: {
    label: "replied",
    classes: "bg-success/10 text-success border-success/20",
  },
  failed: {
    label: "failed",
    classes: "bg-danger/10 text-danger border-danger/20",
  },
};

/**
 * Tolerant lookup — callers often have a generic string status
 * coming from Supabase. Falls back to the "draft" / "pending"
 * entry so the UI never crashes on an unknown value.
 */
export function getBroadcastStatus(status: string): StatusDisplay {
  return (
    broadcastStatusConfig[status as BroadcastStatus] ??
    broadcastStatusConfig.draft
  );
}

export function getRecipientStatus(status: string): StatusDisplay {
  return (
    recipientStatusConfig[status as RecipientStatus] ??
    recipientStatusConfig.pending
  );
}
