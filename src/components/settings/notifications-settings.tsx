'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Bell, Info, Loader2, Smartphone, Trash2, Volume2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import {
  describeDevice,
  isIOS,
  isPushSupported,
  isStandalone,
  PushSetupError,
  subscribeToPush,
} from '@/lib/push/register-push';
import {
  isSoundEnabled,
  setSoundEnabled,
  subscribeSoundPreference,
} from '@/lib/push/notify-sound';
import type { PushEvent } from '@/lib/push/send';
import { SettingsPanelHead } from './settings-panel-head';

interface Device {
  id: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
}

const EVENTS: PushEvent[] = [
  'message_received',
  'handoff',
  'conversation_assigned',
  'unanswered',
];

type Prefs = Record<PushEvent, boolean>;

/** These snapshots are pull-only; nothing pushes a change to notify. */
const noopSubscribe = () => () => {};

const ALL_ON: Prefs = {
  message_received: true,
  handoff: true,
  conversation_assigned: true,
  unanswered: true,
};

/**
 * Notifications panel — per-person, per-device, no admin gate. Anyone
 * can turn on alerts for their own phone, the same way they pick their
 * own theme.
 */
export function NotificationsSettings() {
  const t = useTranslations('Settings.notifications');
  const { accountId } = useAuth();

  const [devices, setDevices] = useState<Device[]>([]);
  const [prefs, setPrefs] = useState<Prefs>(ALL_ON);
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState(false);
  const [testing, setTesting] = useState(false);
  // Browser capabilities are external state, not React state: reading
  // them in an effect would trigger a cascading render, and reading
  // them in a lazy initialiser would disagree with the server render.
  // `useSyncExternalStore` is re-read on every render, so the
  // permission label refreshes after the user answers the prompt.
  const permission = useSyncExternalStore(
    noopSubscribe,
    () => (isPushSupported() ? Notification.permission : 'unsupported'),
    () => 'default' as const,
  );
  const needsInstall = useSyncExternalStore(
    noopSubscribe,
    () => isIOS() && !isStandalone(),
    () => false,
  );
  const sound = useSyncExternalStore(
    subscribeSoundPreference,
    isSoundEnabled,
    () => true,
  );

  // Refetch when the signed-in account changes rather than showing the
  // previous account's devices.
  const loadedAccountIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [devicesRes, prefsRes] = await Promise.all([
        fetch('/api/push/subscriptions'),
        fetch('/api/push/prefs'),
      ]);
      if (!devicesRes.ok || !prefsRes.ok) throw new Error('load failed');

      const devicesJson = await devicesRes.json();
      const prefsJson = await prefsRes.json();
      setDevices(devicesJson.subscriptions ?? []);
      setPrefs({ ...ALL_ON, ...(prefsJson.prefs ?? {}) });
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void refresh();
  }, [accountId, refresh]);

  async function handleEnable() {
    setSubscribing(true);
    try {
      await subscribeToPush();
      toast.success(t('added'));
      await refresh();
    } catch (err) {
      toast.error(
        err instanceof PushSetupError ? err.message : t('saveFailed'),
      );
    } finally {
      setSubscribing(false);
    }
  }

  async function handleRemove(id: string) {
    try {
      const res = await fetch(`/api/push/subscriptions/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('delete failed');
      setDevices((current) => current.filter((d) => d.id !== id));
      toast.success(t('removed'));
    } catch {
      toast.error(t('saveFailed'));
    }
  }

  async function handleTogglePref(event: PushEvent, value: boolean) {
    const previous = prefs;
    const next = { ...prefs, [event]: value };
    setPrefs(next);
    try {
      const res = await fetch('/api/push/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs: next }),
      });
      if (!res.ok) throw new Error('save failed');
    } catch {
      // Roll back so the switch never claims a setting that didn't save.
      setPrefs(previous);
      toast.error(t('saveFailed'));
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const res = await fetch('/api/push/test', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? 'test failed');
      toast.success(t('testSent'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setTesting(false);
    }
  }

  const hasDevices = devices.length > 0;
  const statusLabel =
    permission === 'unsupported'
      ? t('unsupported')
      : permission === 'denied'
        ? t('blocked')
        : hasDevices && permission === 'granted'
          ? t('enabled')
          : t('notEnabled');

  const canEnable =
    permission !== 'unsupported' && permission !== 'denied' && !needsInstall;

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {/* Devices */}
      <div className="space-y-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Smartphone className="size-4 text-muted-foreground" />
            {t('devicesTitle')}
          </h3>
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
            {t('devicesDesc')}
          </p>
        </div>

        {needsInstall && (
          <div className="flex gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-foreground">{t('iosTitle')}</p>
              <p className="mt-1 text-muted-foreground">{t('iosDesc')}</p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleEnable} disabled={!canEnable || subscribing}>
            {subscribing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('enabling')}
              </>
            ) : (
              <>
                <Bell className="size-4" />
                {t('enable')}
              </>
            )}
          </Button>
          {hasDevices && (
            <Button variant="outline" onClick={handleTest} disabled={testing}>
              {testing && <Loader2 className="size-4 animate-spin" />}
              {t('sendTest')}
            </Button>
          )}
          <span className="text-sm text-muted-foreground">{statusLabel}</span>
        </div>

        <div className="rounded-lg border border-border">
          {loading ? (
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : !hasDevices ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              {t('noDevices')}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {devices.map((device) => (
                <li
                  key={device.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {describeDevice(device.user_agent)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(device.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemove(device.id)}
                    aria-label={t('remove')}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Per-event opt-ins */}
      <div className="mt-8 space-y-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Bell className="size-4 text-muted-foreground" />
            {t('eventsTitle')}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('eventsDesc')}
          </p>
        </div>

        <div className="divide-y divide-border rounded-lg border border-border">
          {EVENTS.map((event) => (
            <label
              key={event}
              className="flex cursor-pointer items-start justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {t(`event_${event}`)}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {t(`event_${event}Desc`)}
                </p>
              </div>
              <Switch
                checked={prefs[event]}
                onCheckedChange={(value) => handleTogglePref(event, value)}
                disabled={loading}
              />
            </label>
          ))}
        </div>
      </div>

      {/* Device-local sound */}
      <div className="mt-8 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Volume2 className="size-4 text-muted-foreground" />
          {t('soundTitle')}
        </h3>

        <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-border px-4 py-3">
          <p className="max-w-[62ch] text-sm text-muted-foreground">
            {t('soundDesc')}
          </p>
          <Switch checked={sound} onCheckedChange={setSoundEnabled} />
        </label>
      </div>
    </section>
  );
}
