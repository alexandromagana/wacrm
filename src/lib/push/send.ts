// ============================================================
// Web Push (VAPID) fan-out.
//
// Reaches a person's browser when the app is closed — the one thing
// Supabase Realtime cannot do, and the reason this exists: with
// WhatsApp gone from the owner's phone, an unseen inbox is a missed
// customer.
//
// Best-effort, exactly like `dispatchWebhookEvent`: callers fire these
// from the inbound webhook's `after()` block, so a push-service outage
// must never affect message processing or the 200 OK returned to Meta.
// Nothing here throws; failures are logged and counted.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import webpush from 'web-push';

/**
 * Events a person can be notified about, mirroring the keys of
 * `profiles.push_prefs` (migration 038).
 */
export type PushEvent =
  | 'message_received'
  | 'handoff'
  | 'conversation_assigned'
  | 'unanswered';

export interface PushPayload {
  title: string;
  body: string;
  /** In-app path opened on tap, e.g. `/inbox?c=<conversation-id>`. */
  url: string;
  /**
   * Collapse key. Repeat notifications sharing a tag replace each other
   * instead of stacking, so a chatty customer produces one live
   * notification rather than ten.
   */
  tag?: string;
}

export interface PushResult {
  sent: number;
  /** Subscriptions dropped because the push service reported them dead. */
  removed: number;
}

const NO_OP: PushResult = { sent: 0, removed: 0 };

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * VAPID is configured once per process, lazily — reading env at module
 * load would break `next build`, which imports this file without the
 * runtime secrets present.
 */
let vapidState: 'unconfigured' | 'ready' | 'disabled' = 'unconfigured';

function ensureVapid(): boolean {
  if (vapidState !== 'unconfigured') return vapidState === 'ready';

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

  if (!publicKey || !privateKey) {
    // Push is opt-in infrastructure, like the AI assistant's API key.
    // An account without keys runs the whole app normally, minus push.
    // Warn once, not per message.
    console.warn(
      '[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications disabled.'
    );
    vapidState = 'disabled';
    return false;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    vapidState = 'ready';
    return true;
  } catch (err) {
    console.error('[push] invalid VAPID configuration:', err);
    vapidState = 'disabled';
    return false;
  }
}

/**
 * Which members of `accountId` want `event`, optionally narrowed to one
 * person. Preferences live on `profiles`, which has no FK to
 * `push_subscriptions`, so this is a separate lookup rather than an
 * embedded select.
 */
async function resolveRecipients(
  db: SupabaseClient,
  accountId: string,
  event: PushEvent,
  userId?: string
): Promise<string[]> {
  let query = db
    .from('profiles')
    .select('user_id, push_prefs')
    .eq('account_id', accountId);

  if (userId) query = query.eq('user_id', userId);

  const { data, error } = await query;
  if (error || !data) return [];

  return data
    .filter((row) => {
      const prefs = (row.push_prefs ?? {}) as Record<string, unknown>;
      // Absent key means opted in: a profile written before an event
      // type existed should still be notified about it.
      return prefs[event] !== false;
    })
    .map((row) => row.user_id as string);
}

async function deliver(
  db: SupabaseClient,
  rows: SubscriptionRow[],
  payload: PushPayload
): Promise<PushResult> {
  const body = JSON.stringify(payload);

  const outcomes = await Promise.allSettled(
    rows.map((row) =>
      webpush.sendNotification(
        {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        },
        body
      )
    )
  );

  let sent = 0;
  const dead: string[] = [];

  outcomes.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      sent += 1;
      return;
    }

    const status = (outcome.reason as { statusCode?: number } | undefined)
      ?.statusCode;

    // 404/410 is the push service telling us this endpoint is gone for
    // good (browser data cleared, app uninstalled, subscription
    // rotated). Anything else — timeouts, 5xx — is transient, so the
    // row stays and the next message retries it.
    if (status === 404 || status === 410) {
      dead.push(rows[i].id);
    } else {
      console.error(
        `[push] delivery failed (status ${status ?? 'unknown'}):`,
        outcome.reason
      );
    }
  });

  if (dead.length > 0) {
    const { error } = await db
      .from('push_subscriptions')
      .delete()
      .in('id', dead);
    if (error) console.error('[push] failed pruning dead subscriptions:', error);
  }

  return { sent, removed: dead.length };
}

/**
 * Load this account's subscriptions for the given recipients and push.
 * Every query is scoped by `account_id` in code: callers pass a
 * service-role client, which bypasses RLS.
 */
async function sendTo(
  db: SupabaseClient,
  accountId: string,
  event: PushEvent,
  payload: PushPayload,
  userId?: string,
  ignorePrefs = false
): Promise<PushResult> {
  try {
    if (!ensureVapid()) return NO_OP;

    let recipients: string[];
    if (ignorePrefs && userId) {
      recipients = [userId];
    } else {
      recipients = await resolveRecipients(db, accountId, event, userId);
    }
    if (recipients.length === 0) return NO_OP;

    const { data: rows, error } = await db
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('account_id', accountId)
      .in('user_id', recipients);

    if (error || !rows || rows.length === 0) return NO_OP;

    return await deliver(db, rows as SubscriptionRow[], payload);
  } catch (err) {
    console.error('[push] send failed:', err);
    return NO_OP;
  }
}

/**
 * Push to every device of one person. Never throws.
 *
 * `ignorePrefs` exists for the "send me a test notification" button:
 * that request is an explicit ask, and silently dropping it because the
 * person muted this event type would look like broken plumbing.
 */
export async function sendPushToUser(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  event: PushEvent,
  payload: PushPayload,
  options?: { ignorePrefs?: boolean }
): Promise<PushResult> {
  return sendTo(
    db,
    accountId,
    event,
    payload,
    userId,
    options?.ignorePrefs ?? false
  );
}

/**
 * Push to every subscribed member of an account — used when nobody owns
 * the conversation yet, so whoever is free can pick it up. Never throws.
 */
export async function sendPushToAccount(
  db: SupabaseClient,
  accountId: string,
  event: PushEvent,
  payload: PushPayload
): Promise<PushResult> {
  return sendTo(db, accountId, event, payload);
}

/** Test seam — lets suites exercise the missing-keys path in isolation. */
export function resetVapidStateForTests(): void {
  vapidState = 'unconfigured';
}
