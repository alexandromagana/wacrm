/* eslint-disable no-undef */
// ============================================================
// Service worker — Web Push receiver.
//
// Deliberately minimal. There is NO `fetch` handler: this worker
// exists so the browser can wake the app for a push (and so iOS will
// let the site be installed at all), not to cache or proxy anything.
// Intercepting requests here would put a cache in front of
// authenticated, per-user server-rendered pages — a correctness and
// privacy risk with no offline requirement to justify it.
// ============================================================

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A malformed or plain-text push must still surface something
    // rather than silently dropping — a missed message is the exact
    // failure this feature exists to prevent.
    payload = {};
  }

  const title = payload.title || 'Gama Energía';

  const options = {
    body: payload.body || 'Tienes un mensaje nuevo.',
    data: { url: payload.url || '/inbox' },
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };

  // A tag collapses repeat notifications for one conversation into a
  // single panel entry instead of a stack of ten. But replacing is
  // SILENT by default on Android — no sound, no vibration — so a chatty
  // customer would alert once and then go quiet while messages piled up
  // unseen. `renotify` keeps the collapsing and restores the alert.
  //
  // Only set when we actually have a per-conversation tag: an untagged
  // fallback shared by every push would collapse unrelated threads into
  // one entry, which is worse than stacking. (`renotify` without `tag`
  // also throws a TypeError.)
  if (payload.tag) {
    options.tag = payload.tag;
    options.renotify = true;
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/inbox';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Reuse a tab that already has the app open — opening a second
      // window every time someone taps a notification is how you end
      // up with fifteen copies of the inbox.
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) await client.navigate(url);
          return;
        }
      }

      await self.clients.openWindow(url);
    })(),
  );
});
