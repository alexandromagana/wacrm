import { shortRef } from './crm-auditor.mjs';

const REFERENCE_KINDS = new Set(['conversation', 'automation', 'flow']);
const OPAQUE_REFERENCE = /^[0-9a-f]{32}$/;
const RAW_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validateReferenceRequest(kind, reference) {
  if (!REFERENCE_KINDS.has(kind) || !OPAQUE_REFERENCE.test(reference ?? '')) {
    throw new Error('Invalid CRM reference request.');
  }
  return { kind, reference };
}

export function findUniqueRawId(reference, rows, referenceKey) {
  if (!OPAQUE_REFERENCE.test(reference ?? '') || !Array.isArray(rows)) {
    throw new Error('Unable to resolve reference safely.');
  }

  const seen = new Set();
  for (const row of rows) {
    if (
      row === null ||
      typeof row !== 'object' ||
      Object.getPrototypeOf(row) !== Object.prototype ||
      Object.keys(row).length !== 1 ||
      typeof row.id !== 'string' ||
      !RAW_UUID_PATTERN.test(row.id) ||
      seen.has(row.id)
    ) {
      throw new Error('Unable to resolve reference safely.');
    }
    seen.add(row.id);
  }
  const references = new Map();
  const matches = rows.filter((row) => {
    const candidate = shortRef(row.id, referenceKey);
    const existing = references.get(candidate);
    if (existing !== undefined && existing !== row.id) {
      throw new Error('Unable to resolve reference safely.');
    }
    references.set(candidate, row.id);
    return candidate === reference;
  });
  if (matches.length !== 1 || !RAW_UUID_PATTERN.test(matches[0].id)) {
    throw new Error('Unable to resolve reference safely.');
  }
  return matches[0].id;
}

export function validateCrmOrigin(siteUrl) {
  let parsed;
  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new Error('Invalid CRM origin.');
  }

  if (
    typeof siteUrl !== 'string' ||
    siteUrl !== parsed.origin ||
    parsed.username ||
    parsed.password ||
    parsed.protocol !== 'https:'
  ) {
    throw new Error('Invalid CRM origin.');
  }
  return parsed.origin;
}

export function buildCrmReferenceUrl(siteUrl, kind, rawId) {
  if (!REFERENCE_KINDS.has(kind) || !RAW_UUID_PATTERN.test(rawId ?? '')) {
    throw new Error('Invalid raw ID for resolver.');
  }

  const origin = validateCrmOrigin(siteUrl);
  if (kind === 'conversation') {
    const url = new URL('/inbox', origin);
    url.searchParams.set('c', rawId);
    return url.toString();
  }
  if (kind === 'automation') {
    return new URL(
      `/automations/${encodeURIComponent(rawId)}/logs`,
      origin
    ).toString();
  }
  return new URL(`/flows/${encodeURIComponent(rawId)}/runs`, origin).toString();
}

export function publicResolverResult(kind, reference) {
  return {
    opened: true,
    ...validateReferenceRequest(kind, reference),
  };
}
