/**
 * WhatsApp's 24-hour customer-service window: once a customer messages
 * in, a business may send free-form replies for 24 hours; after that,
 * only pre-approved template messages are allowed until the customer
 * messages again. An agent's own reply never resets the window — only
 * a customer-sent message does.
 *
 * Pure date math, shared by:
 *  - message-thread.tsx's countdown badge, which sources the timestamp
 *    from the already-loaded `messages` array (freshest — updates the
 *    instant a new customer message lands in the realtime subscription).
 *  - conversation-list.tsx's expired indicator, which sources it from
 *    the `conversations.last_customer_message_at` column (migration
 *    039) — the list has no per-row message stream, so this column is
 *    the only affordable way to know this for a whole page of rows.
 *
 * Both callers feed this the same threshold, so the two surfaces can't
 * silently disagree about when a window has lapsed.
 */

import { differenceInHours } from "date-fns";

const WINDOW_HOURS = 24;

export type SessionRemaining =
  | { kind: "noCustomerMessage" }
  | { kind: "expired" }
  | { kind: "hoursRemaining"; hours: number }
  // `differenceInHours` below truncates to whole hours, so `hoursLeft`
  // is always a whole number too (1-24) right up until the window
  // flips to expired — this branch is preserved from the original
  // inline calc for whenever the math below changes, but isn't reached
  // by the truncating version currently in use.
  | { kind: "minutesRemaining"; minutes: number };

export interface WhatsAppSessionInfo {
  /**
   * False when this contact has never sent a message (e.g. a fresh
   * outbound-first conversation) — distinct from a real expired window.
   * Callers that gate free-text sending must treat this the same as
   * `windowExpired` (WhatsApp allows templates only in both cases);
   * callers that render a "window lapsed" indicator should NOT — a
   * brand-new lead who hasn't replied yet isn't an expired session.
   */
  hasCustomerMessage: boolean;
  /** True only when a customer message exists AND >=24h have elapsed. */
  windowExpired: boolean;
  remaining: SessionRemaining;
}

export function getWhatsAppSessionInfo(
  lastCustomerMessageAt: string | null | undefined,
  now: Date = new Date(),
): WhatsAppSessionInfo {
  if (!lastCustomerMessageAt) {
    return {
      hasCustomerMessage: false,
      windowExpired: false,
      remaining: { kind: "noCustomerMessage" },
    };
  }

  const hoursSince = differenceInHours(now, new Date(lastCustomerMessageAt));

  if (hoursSince >= WINDOW_HOURS) {
    return {
      hasCustomerMessage: true,
      windowExpired: true,
      remaining: { kind: "expired" },
    };
  }

  const hoursLeft = WINDOW_HOURS - hoursSince;
  return {
    hasCustomerMessage: true,
    windowExpired: false,
    remaining:
      hoursLeft >= 1
        ? { kind: "hoursRemaining", hours: Math.floor(hoursLeft) }
        : { kind: "minutesRemaining", minutes: Math.floor(hoursLeft * 60) },
  };
}
