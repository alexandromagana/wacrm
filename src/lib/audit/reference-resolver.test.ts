import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { shortRef as shortRefRaw } from './crm-auditor.mjs';
import {
  buildCrmReferenceUrl,
  findUniqueRawId,
  publicResolverResult,
  validateReferenceRequest,
} from './reference-resolver.mjs';

const REFERENCE_KEY = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo';
const shortRef = (value: unknown) => shortRefRaw(value, REFERENCE_KEY);

describe('shortRef key contract', () => {
  it('decodes one canonical 32-byte base64url key before hashing', () => {
    const rawKey = Buffer.alloc(32, 0x5a);
    const encodedKey = rawKey.toString('base64url');
    const value = '123e4567-e89b-42d3-a456-426614174000';
    const expected = createHmac('sha256', rawKey)
      .update('gama-crm-audit-reference-v2\0')
      .update(value, 'utf8')
      .digest('hex')
      .slice(0, 32);

    expect(shortRefRaw(value, encodedKey)).toBe(expected);
  });
});

describe('validateReferenceRequest', () => {
  it('accepts only a closed kind and a lowercase 32-hex reference', () => {
    const reference = '0123456789abcdef0123456789abcdef';
    expect(validateReferenceRequest('conversation', reference)).toEqual({
      kind: 'conversation',
      reference,
    });

    expect(() => validateReferenceRequest('contact', reference)).toThrow(
      /reference request/i
    );
    expect(() =>
      validateReferenceRequest(
        'conversation',
        '0123456789ABCDEF0123456789ABCDEG'
      )
    ).toThrow(/reference request/i);
  });
});

describe('findUniqueRawId', () => {
  it('resolves exactly one opaque reference without changing its hash rule', () => {
    const rawId = '123e4567-e89b-42d3-a456-426614174000';

    expect(
      findUniqueRawId(shortRef(rawId), [{ id: rawId }], REFERENCE_KEY)
    ).toBe(rawId);
  });

  it('accepts every canonical lowercase UUID accepted by the reader', () => {
    const canonical = '00000000-0000-0000-0000-000000000001';
    expect(
      findUniqueRawId(shortRef(canonical), [{ id: canonical }], REFERENCE_KEY)
    ).toBe(canonical);
  });

  it('fails closed for missing and ambiguous references', () => {
    const duplicateId = '123e4567-e89b-42d3-a456-426614174000';
    const reference = shortRef(duplicateId);

    expect(() => findUniqueRawId(reference, [], REFERENCE_KEY)).toThrow(
      /resolve reference/i
    );
    expect(() =>
      findUniqueRawId(
        reference,
        [{ id: duplicateId }, { id: duplicateId }],
        REFERENCE_KEY
      )
    ).toThrow(/resolve reference/i);
  });

  it('rejects malformed or extra fields anywhere in the resolver response', () => {
    const rawId = '123e4567-e89b-42d3-a456-426614174000';
    const reference = shortRef(rawId);

    expect(() =>
      findUniqueRawId(
        reference,
        [{ id: rawId }, { id: 'not-a-uuid' }],
        REFERENCE_KEY
      )
    ).toThrow(/resolve reference/i);
    expect(() =>
      findUniqueRawId(
        reference,
        [{ id: rawId, name: 'untrusted' }],
        REFERENCE_KEY
      )
    ).toThrow(/resolve reference/i);
  });

  it('rejects duplicate identifiers even when they do not match the reference', () => {
    const rawId = '123e4567-e89b-42d3-a456-426614174000';
    const duplicate = '223e4567-e89b-42d3-a456-426614174000';
    expect(() =>
      findUniqueRawId(
        shortRef(rawId),
        [{ id: rawId }, { id: duplicate }, { id: duplicate }],
        REFERENCE_KEY
      )
    ).toThrow(/resolve reference/i);
  });
});

describe('buildCrmReferenceUrl', () => {
  const rawId = '123e4567-e89b-42d3-a456-426614174000';

  it.each([
    ['conversation', 'https://crm.example.com/inbox?c=' + rawId],
    ['automation', 'https://crm.example.com/automations/' + rawId + '/logs'],
    ['flow', 'https://crm.example.com/flows/' + rawId + '/runs'],
  ] as const)('builds the pinned route for %s', (kind, expected) => {
    expect(buildCrmReferenceUrl('https://crm.example.com', kind, rawId)).toBe(
      expected
    );
  });

  it('requires an exact HTTPS origin and rejects unsafe origins and raw IDs', () => {
    expect(() =>
      buildCrmReferenceUrl(
        'https://crm.example.com/base?unsafe=1',
        'conversation',
        rawId
      )
    ).toThrow(/CRM origin/i);
    expect(() =>
      buildCrmReferenceUrl('http://localhost:3000', 'conversation', rawId)
    ).toThrow(/CRM origin/i);
    expect(() =>
      buildCrmReferenceUrl('http://crm.example.com', 'conversation', rawId)
    ).toThrow(/CRM origin/i);
    expect(() =>
      buildCrmReferenceUrl('https://user:pass@crm.example.com', 'flow', rawId)
    ).toThrow(/CRM origin/i);
    expect(() =>
      buildCrmReferenceUrl(
        'https://crm.example.com',
        'conversation',
        '../raw-id'
      )
    ).toThrow(/raw ID/i);
  });
});

describe('publicResolverResult', () => {
  it('never returns the raw ID or opened URL', () => {
    const rawId = '123e4567-e89b-42d3-a456-426614174000';
    const reference = shortRef(rawId);
    const result = publicResolverResult('conversation', reference);
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      opened: true,
      kind: 'conversation',
      reference,
    });
    expect(serialized).not.toContain(rawId);
    expect(serialized).not.toContain('http');
  });
});
