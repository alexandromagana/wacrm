import { describe, expect, it } from 'vitest';

import { describeDevice, urlBase64ToUint8Array } from './register-push';

describe('urlBase64ToUint8Array', () => {
  it('decodes a padded standard-alphabet string', () => {
    // "hello" → aGVsbG8=
    expect(Array.from(urlBase64ToUint8Array('aGVsbG8='))).toEqual([
      104, 101, 108, 108, 111,
    ]);
  });

  it('restores stripped padding', () => {
    // VAPID keys ship unpadded; atob rejects those, so the helper has
    // to add the '=' back or subscribe() fails with a decode error.
    expect(Array.from(urlBase64ToUint8Array('aGVsbG8'))).toEqual([
      104, 101, 108, 108, 111,
    ]);
  });

  it('maps the url-safe alphabet back to standard base64', () => {
    // 0xFB 0xEF decodes from '++8=' in standard base64 and '--8' in
    // url-safe form; both must yield the same bytes.
    const standard = Array.from(urlBase64ToUint8Array('++8='));
    const urlSafe = Array.from(urlBase64ToUint8Array('--8'));
    expect(urlSafe).toEqual(standard);
  });

  it('produces the 65-byte key length PushManager expects', () => {
    // A real VAPID public key is 65 raw bytes (uncompressed P-256
    // point). 87 base64url chars, unpadded.
    const key = 'B' + 'a'.repeat(86);
    expect(urlBase64ToUint8Array(key)).toHaveLength(65);
  });
});

describe('describeDevice', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Safari · iPhone',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Chrome · Windows',
    ],
    [
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Chrome · Android',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      'Edge · Windows',
    ],
  ])('labels %#', (ua, expected) => {
    expect(describeDevice(ua)).toBe(expected);
  });

  it('falls back when the user agent was never recorded', () => {
    expect(describeDevice(null)).toBe('Unknown device');
  });
});
