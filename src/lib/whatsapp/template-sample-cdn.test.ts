import { describe, expect, it } from 'vitest';

import { isMetaSampleCdnUrl } from './template-sample-cdn';

describe('isMetaSampleCdnUrl', () => {
  it('flags the scontent link Meta hands back as an approval sample', () => {
    // Trimmed from the real header_handle that the Aug 22 sync wrote
    // over two working templates. Note oe/oh are still valid — a live
    // signature is not evidence the link is sendable.
    const url =
      'https://scontent.whatsapp.net/v/t61.29466-34/670972120_2513651302417240_4381197286338391578_n.png' +
      '?ccb=1-7&_nc_sid=8b1bef&oh=01_Q5Aa5QEklidmfVcAmdql595F6xNTUSetSbiyEkGcL7Iu---izQ&oe=6AB139E0';
    expect(isMetaSampleCdnUrl(url)).toBe(true);
  });

  it('flags the other Meta media hosts', () => {
    expect(isMetaSampleCdnUrl('https://mmg.whatsapp.net/d/f/abc.enc')).toBe(true);
    expect(isMetaSampleCdnUrl('https://lookaside.fbsbx.com/whatsapp/1234')).toBe(
      true,
    );
  });

  it('matches subdomains but not lookalike hosts', () => {
    expect(isMetaSampleCdnUrl('https://cdn.scontent.whatsapp.net/x.png')).toBe(
      true,
    );
    // The suffix check must be anchored on a dot, or an attacker-ish
    // (or merely unlucky) host ending in the same letters would be
    // treated as Meta's and silently dropped from the sync.
    expect(isMetaSampleCdnUrl('https://notscontent.whatsapp.net.evil.com/x')).toBe(
      false,
    );
  });

  it('leaves a normal storage URL alone', () => {
    const url =
      'https://sbrzkpdpcnacnbidcxhb.supabase.co/storage/v1/object/public/chat-media/header.png';
    expect(isMetaSampleCdnUrl(url)).toBe(false);
  });

  it('returns false for an opaque resumable-upload handle', () => {
    // Not a URL — the send builder rejects these on its own, so this
    // helper must not claim them.
    expect(isMetaSampleCdnUrl('4::aW1hZ2UvanBlZw==:ARb9x_handle')).toBe(false);
    expect(isMetaSampleCdnUrl('')).toBe(false);
  });
});
