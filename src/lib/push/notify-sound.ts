// ============================================================
// In-tab alerts for the inbox.
//
// Complements Web Push rather than duplicating it: when the inbox is
// already open, Supabase Realtime knows about the message before any
// push round-trip completes, so this path is what actually makes an
// office machine chime.
//
// Device-scoped on purpose — "make noise on this computer" is a
// property of where you're sitting, not of your account, so it lives in
// localStorage next to the theme rather than in the database.
// ============================================================

export const SOUND_STORAGE_KEY = 'wacrm:notify-sound';

/** Same-tab change signal; `storage` only fires in *other* tabs. */
const SOUND_CHANGE_EVENT = 'wacrm:notify-sound-changed';

export function isSoundEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  // Default on: someone with the inbox open wants to hear a customer
  // arrive. Opting out is the deliberate choice.
  return window.localStorage.getItem(SOUND_STORAGE_KEY) !== 'off';
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SOUND_STORAGE_KEY, enabled ? 'on' : 'off');
  window.dispatchEvent(new Event(SOUND_CHANGE_EVENT));
}

/** `useSyncExternalStore` subscriber — keeps every open tab in step. */
export function subscribeSoundPreference(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(SOUND_CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(SOUND_CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function playNotifySound(): void {
  if (typeof window === 'undefined' || !isSoundEnabled()) return;
  try {
    const audio = new Audio('/sounds/notify.wav');
    audio.volume = 0.5;
    // Chrome blocks playback on a page that has never been interacted
    // with. Nothing to recover from — the desktop notification still
    // fires, and this must not throw inside a Realtime callback.
    void audio.play().catch(() => {});
  } catch {
    // Ignore — a missing/undecodable asset must not break the inbox.
  }
}

/**
 * Desktop notification for a tab that is open but not being looked at.
 * Silently does nothing without permission; the Settings screen is the
 * only place that asks for it.
 */
export function showDesktopNotification(
  title: string,
  body: string,
  onClick?: () => void,
): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  try {
    const notification = new Notification(title, {
      body,
      icon: '/icons/icon-192.png',
      // Shared tag with the service worker's pushes so a message never
      // shows twice when both paths fire.
      tag: 'wacrm-inbox',
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      onClick?.();
    };
  } catch {
    // Some browsers throw on the Notification constructor when the
    // page is controlled by a service worker; the push path covers it.
  }
}
