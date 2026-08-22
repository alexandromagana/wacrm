import type { MetadataRoute } from 'next';

/**
 * Web App Manifest.
 *
 * Exists for push notifications, not for offline support: iOS only
 * grants the Push API to a site the user has added to their Home
 * Screen, and that install prompt requires a manifest. Android and
 * desktop Chrome get an installable app out of it too.
 *
 * `start_url` points at the inbox rather than `/` — someone launching
 * the installed app is almost always coming to read a message, usually
 * straight off a notification.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Gama Energía',
    short_name: 'Gama',
    description: 'Gama Energía, CRM para WhatsApp.',
    start_url: '/inbox',
    display: 'standalone',
    background_color: '#0a0b0d',
    theme_color: '#0a0b0d',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      {
        // Android crops adaptive icons to arbitrary shapes; this copy
        // keeps the mark inside the safe zone so the rays survive.
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
