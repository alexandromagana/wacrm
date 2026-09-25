export function decodeReferenceKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('Invalid CRM reference key.');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== value) {
    throw new Error('Invalid CRM reference key.');
  }
  return bytes;
}
