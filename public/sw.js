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

  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || 'Tienes un mensaje nuevo.',
      // Same tag replaces the previous notification instead of stacking,
      // so a customer sending five messages leaves one entry.
      tag: payload.tag || 'wacrm',
      data: { url: payload.url || '/inbox' },
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
    }),
  );
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
