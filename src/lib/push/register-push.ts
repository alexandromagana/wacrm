// ============================================================
// Browser-side push registration.
//
// Every entry point is called from an explicit click in Settings —
// never on page load. An unprompted permission dialog is both hostile
// and counterproductive: browsers penalise sites that ask cold, and a
// denied permission cannot be re-requested from the page.
// ============================================================

/** VAPID keys arrive base64url-encoded; PushManager wants raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalised);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** True when launched from an installed icon rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari predates the display-mode media query.
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ reports itself as a Mac; the touch check separates it
    // from an actual desktop, which does not need the install detour.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function permissionState(): NotificationPermission | 'unsupported' {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

export async function registerPushSw(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register('/sw.js');
  // A freshly registered worker isn't controlling the page yet;
  // subscribing before it activates throws.
  await navigator.serviceWorker.ready;
  return registration;
}

export class PushSetupError extends Error {}

/**
 * Ask for permission, subscribe, and hand the subscription to the
 * server. Throws `PushSetupError` with a message suitable for a toast.
 */
export async function subscribeToPush(): Promise<void> {
  if (!isPushSupported()) {
    throw new PushSetupError('This browser does not support notifications.');
  }

  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidKey) {
    throw new PushSetupError(
      'Push notifications are not configured on the server.',
    );
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new PushSetupError(
      'Notifications are blocked. Allow them for this site in your browser settings.',
    );
  }

  const registration = await registerPushSw();

  // Reuse an existing subscription when there is one: re-subscribing
  // with the same key returns the same endpoint anyway, and this keeps
  // the call cheap on repeat visits.
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // Required by Chrome: every push must result in a visible
      // notification. Our service worker always shows one.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
    }));

  const payload = subscription.toJSON();

  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: payload.endpoint,
      keys: payload.keys,
      userAgent: navigator.userAgent,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new PushSetupError(body?.error ?? 'Failed to register this device.');
  }
}

/**
 * Turn a raw user-agent string into something a person recognises in a
 * device list. Intentionally rough — it only has to be good enough to
 * tell "my phone" from "the office iMac".
 */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';

  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Firefox\//.test(userAgent)
          ? 'Firefox'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'Browser';

  const os = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Mac OS X/.test(userAgent)
          ? 'Mac'
          : /Windows/.test(userAgent)
            ? 'Windows'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : 'device';

  return `${browser} · ${os}`;
}
