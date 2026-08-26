/**
 * Tell Meta's own re-hosted approval sample apart from a media URL we
 * can actually send with.
 *
 * When a media-header template is approved, Meta copies the sample
 * image onto one of its CDNs and hands that link back as
 * `example.header_handle`. The link is publicly fetchable — curl gets a
 * 200 — so a naive `/^https?:\/\//` test accepts it. But it is a
 * creation-time artifact, not a send-time asset: passing it as
 * `image.link` on POST /{phone_number_id}/messages gets the send
 * ACCEPTED (Meta returns a wamid, the message is stored as `sent`) and
 * then silently dropped at delivery. The only symptom is a `failed`
 * status webhook arriving later, which is why this failure mode reads
 * as "the template was sent but never arrived" rather than as an error.
 *
 * Only the host matters. The signature and expiry query params on these
 * links (`oh`, `oe`, `_nc_gid`, …) can still be perfectly valid while
 * the link remains unusable for sending, so there is nothing to learn
 * from parsing them.
 */

const META_SAMPLE_CDN_HOSTS = [
  'scontent.whatsapp.net',
  'mmg.whatsapp.net',
  'lookaside.fbsbx.com',
];

export function isMetaSampleCdnUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Not a URL at all — an opaque Resumable-Upload handle, most
    // likely. Callers reject those separately; it is not a CDN sample.
    return false;
  }
  return META_SAMPLE_CDN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
