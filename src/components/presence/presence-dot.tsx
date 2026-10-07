import { cn } from "@/lib/utils";
import type { PresenceStatus } from "@/lib/presence";

// Single source of truth for presence colours. Online and away are
// states, so they take the success / warning status tokens (see
// STATUS in globals.css); offline stays neutral.
export const PRESENCE_DOT_CLASS: Record<PresenceStatus, string> = {
  online: "bg-success",
  away: "bg-warning",
  offline: "bg-muted-foreground/50",
};

/**
 * A small presence dot. Used inline (e.g. the inbox Assign dropdown)
 * and, with `asAvatarBadge`-style positioning supplied via className,
 * layered onto an avatar. `label` powers the native title/aria for
 * the lightweight inline case; the roster wraps it in a real Tooltip.
 */
export function PresenceDot({
  status,
  label,
  className,
}: {
  status: PresenceStatus;
  label?: string;
  className?: string;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      title={label}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        PRESENCE_DOT_CLASS[status],
        className,
      )}
    />
  );
}
