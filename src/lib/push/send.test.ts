import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetVapidStateForTests,
  sendPushToAccount,
  sendPushToUser,
} from './send';

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const webpush = (await import('web-push')).default as any;

interface ProfileRow {
  user_id: string;
  push_prefs: Record<string, boolean> | null;
}
interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_id: string;
  account_id: string;
}

/**
 * Minimal PostgREST-shaped stub: every method returns the builder and
 * the builder is thenable, so `await db.from(t).select().eq(...)`
 * behaves like the real client. Filters are recorded so the tests can
 * assert scoping — the service-role client bypasses RLS, so
 * `account_id` / `user_id` narrowing exists only in our own code.
 */
function makeDb(profiles: ProfileRow[], subs: SubRow[]) {
  const deleted: string[][] = [];
  const subFilters: Record<string, unknown>[] = [];

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let isDelete = false;

    const run = () => {
      if (isDelete) {
        deleted.push(filters['id__in'] as string[]);
        return { data: null, error: null };
      }
      if (table === 'profiles') {
        const rows = filters.user_id
          ? profiles.filter((p) => p.user_id === filters.user_id)
          : profiles;
        return { data: rows, error: null };
      }
      subFilters.push({ ...filters });
      const allowed = filters['user_id__in'] as string[] | undefined;
      return {
        data: subs.filter(
          (s) =>
            s.account_id === filters.account_id &&
            (!allowed || allowed.includes(s.user_id))
        ),
        error: null,
      };
    };

    const q = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        filters[`${col}__in`] = vals;
        return q;
      },
      delete: () => {
        isDelete = true;
        return q;
      },
      then: (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve(run()).then(onFulfilled),
    };
    return q;
  }

  return {
    db: { from: (table: string) => builder(table) } as never,
    deleted,
    subFilters,
  };
}

const payload = { title: 'Ana', body: 'Hola', url: '/inbox?c=c1' };

function sub(id: string, userId: string, accountId = 'acc1'): SubRow {
  return {
    id,
    endpoint: `https://push.example/${id}`,
    p256dh: 'key',
    auth: 'auth',
    user_id: userId,
    account_id: accountId,
  };
}

describe('push send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVapidStateForTests();
    process.env.VAPID_PUBLIC_KEY = 'pub';
    process.env.VAPID_PRIVATE_KEY = 'priv';
    webpush.sendNotification.mockResolvedValue({ statusCode: 201 });
  });

  it('sends to every device of the account when nobody is assigned', async () => {
    const { db } = makeDb(
      [
        { user_id: 'u1', push_prefs: null },
        { user_id: 'u2', push_prefs: null },
      ],
      [sub('s1', 'u1'), sub('s2', 'u2')]
    );

    const res = await sendPushToAccount(db, 'acc1', 'message_received', payload);

    expect(res).toEqual({ sent: 2, removed: 0 });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  it('scopes to a single person when the conversation is assigned', async () => {
    const { db, subFilters } = makeDb(
      [
        { user_id: 'u1', push_prefs: null },
        { user_id: 'u2', push_prefs: null },
      ],
      [sub('s1', 'u1'), sub('s2', 'u2')]
    );

    const res = await sendPushToUser(
      db,
      'acc1',
      'u2',
      'message_received',
      payload
    );

    expect(res.sent).toBe(1);
    expect(subFilters[0]['user_id__in']).toEqual(['u2']);
    expect(subFilters[0].account_id).toBe('acc1');
  });

  it('skips people who muted that event', async () => {
    const { db } = makeDb(
      [
        { user_id: 'u1', push_prefs: { message_received: false } },
        { user_id: 'u2', push_prefs: { message_received: true } },
      ],
      [sub('s1', 'u1'), sub('s2', 'u2')]
    );

    const res = await sendPushToAccount(db, 'acc1', 'message_received', payload);

    expect(res.sent).toBe(1);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('still delivers a muted event when prefs are explicitly ignored', async () => {
    // The "send me a test notification" button — an explicit request
    // must not be silently swallowed by a muted event type.
    const { db } = makeDb(
      [{ user_id: 'u1', push_prefs: { message_received: false } }],
      [sub('s1', 'u1')]
    );

    const res = await sendPushToUser(
      db,
      'acc1',
      'u1',
      'message_received',
      payload,
      { ignorePrefs: true }
    );

    expect(res.sent).toBe(1);
  });

  it('treats an unknown event key as opted in', async () => {
    // A profile row written before `handoff` existed has no such key;
    // absence must not silently mute a new event type.
    const { db } = makeDb(
      [{ user_id: 'u1', push_prefs: { message_received: true } }],
      [sub('s1', 'u1')]
    );

    const res = await sendPushToAccount(db, 'acc1', 'handoff', payload);

    expect(res.sent).toBe(1);
  });

  it.each([404, 410])(
    'prunes a subscription the push service reports gone (%i)',
    async (statusCode) => {
      const { db, deleted } = makeDb(
        [{ user_id: 'u1', push_prefs: null }],
        [sub('s1', 'u1')]
      );
      webpush.sendNotification.mockRejectedValue({ statusCode });

      const res = await sendPushToAccount(
        db,
        'acc1',
        'message_received',
        payload
      );

      expect(res).toEqual({ sent: 0, removed: 1 });
      expect(deleted).toEqual([['s1']]);
    }
  );

  it('keeps the subscription on a transient failure', async () => {
    const { db, deleted } = makeDb(
      [{ user_id: 'u1', push_prefs: null }],
      [sub('s1', 'u1')]
    );
    webpush.sendNotification.mockRejectedValue({ statusCode: 500 });

    const res = await sendPushToAccount(db, 'acc1', 'message_received', payload);

    expect(res).toEqual({ sent: 0, removed: 0 });
    expect(deleted).toEqual([]);
  });

  it('no-ops without VAPID keys instead of throwing', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    const { db } = makeDb(
      [{ user_id: 'u1', push_prefs: null }],
      [sub('s1', 'u1')]
    );

    const res = await sendPushToAccount(db, 'acc1', 'message_received', payload);

    expect(res).toEqual({ sent: 0, removed: 0 });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('never throws when the database errors', async () => {
    const db = {
      from: () => {
        throw new Error('connection lost');
      },
    } as never;

    await expect(
      sendPushToAccount(db, 'acc1', 'message_received', payload)
    ).resolves.toEqual({ sent: 0, removed: 0 });
  });
});
