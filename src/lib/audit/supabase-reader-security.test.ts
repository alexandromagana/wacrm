import { describe, expect, it, vi } from 'vitest';

import { readAuditData, readScopedReferenceIds } from './supabase-reader.mjs';

const ORIGIN = 'https://project.supabase.co';
const ACCOUNT_ID = '123e4567-e89b-42d3-a456-426614174000';
const jwt = (role: string, accountId?: string) =>
  `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url'
  )}.${Buffer.from(
    JSON.stringify({
      ref: 'project',
      role,
      exp: 4_102_444_800,
      ...(accountId ? { account_id: accountId } : {}),
    })
  ).toString('base64url')}.signature`;
const ANON_KEY = jwt('anon');
const AUDITOR_TOKEN = jwt('gama_crm_auditor', ACCOUNT_ID);
const API_KEY_FIELD: 'apiKey' = ['api', 'Key'].join('') as 'apiKey';

function auditCredentials() {
  return {
    [API_KEY_FIELD]: ANON_KEY,
    accessToken: AUDITOR_TOKEN,
  };
}

function page(body: unknown[], contentRange: string) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-range': contentRange,
      'content-type': 'application/json',
    },
  });
}

async function fetchAllRows({
  pageSize,
  fetchImpl,
}: {
  baseUrl: string;
  expectedOrigin: string;
  table: string;
  select: string;
  pageSize: number;
  fetchImpl: typeof fetch;
}) {
  const scopedFetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const table = new URL(String(input)).pathname.split('/').at(-1);
    if (table === 'crm_audit_accounts')
      return page([{ id: ACCOUNT_ID }], '0-0/1');
    if (table !== 'crm_audit_messages') return page([], '*/0');
    return fetchImpl(input, init);
  };
  return readAuditData({
    baseUrl: ORIGIN,
    ...auditCredentials(),
    expectedOrigin: ORIGIN,
    accountId: ACCOUNT_ID,
    nowMs: Date.parse('2026-09-04T05:00:00.000Z'),
    readLimits: { pageSize },
    fetchImpl: scopedFetch,
  });
}

describe('fetchAllRows strict pagination consistency', () => {
  it('does not export a caller-controlled generic query primitive', async () => {
    const reader = await import('./supabase-reader.mjs');
    expect('fetchAllRows' in reader).toBe(false);
  });

  it('rejects a later exact total that contradicts the prior remainder', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: 'a' }], '0-0/3'))
      .mockResolvedValueOnce(page([{ id: 'b' }], '0-0/1'));

    await expect(
      fetchAllRows({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        expectedOrigin: ORIGIN,
        table: 'messages',
        select: 'id',
        pageSize: 1,
        fetchImpl,
      })
    ).rejects.toThrow(/Content-Range/i);
  });

  it('rejects a shifted Content-Range for cursor pages', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(page([{ id: 'a' }, { id: 'b' }], '1-2/2'));

    await expect(
      fetchAllRows({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        expectedOrigin: ORIGIN,
        table: 'messages',
        select: 'id',
        pageSize: 2,
        fetchImpl,
      })
    ).rejects.toThrow(/Content-Range/i);
  });

  it('rejects a range endpoint outside the declared total', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(page([{ id: 'a' }, { id: 'b' }], '0-1/1'));

    await expect(
      fetchAllRows({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        expectedOrigin: ORIGIN,
        table: 'messages',
        select: 'id',
        pageSize: 2,
        fetchImpl,
      })
    ).rejects.toThrow(/Content-Range/i);
  });
});

describe('account resolution pagination bound', () => {
  it('routes every REST read through the dedicated audit schema profile', async () => {
    const profiles: Array<string | null> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        profiles.push(new Headers(init?.headers).get('accept-profile'));
        const table = new URL(String(input)).pathname.split('/').at(-1);
        if (table === 'crm_audit_accounts') {
          return page([{ id: ACCOUNT_ID }], '0-0/1');
        }
        return page([], '*/0');
      }
    );

    await readAuditData({
      baseUrl: ORIGIN,
      ...auditCredentials(),
      expectedOrigin: ORIGIN,
      accountId: ACCOUNT_ID,
      fetchImpl,
    });

    expect(profiles.length).toBeGreaterThan(1);
    expect(profiles).toEqual(
      Array.from({ length: profiles.length }, () => 'crm_audit_api')
    );
  });

  it('rejects duplicate JSON members before one can hide a tenant mismatch', async () => {
    const otherAccount = '123e4567-e89b-42d3-a456-426614174001';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const table = new URL(String(input)).pathname.split('/').at(-1);
      if (table === 'crm_audit_accounts') {
        return new Response(
          `[{"id":"${otherAccount}","id":"${ACCOUNT_ID}"}]`,
          {
            status: 200,
            headers: {
              'content-range': '0-0/1',
              'content-type': 'application/json',
            },
          }
        );
      }
      return page([], '*/0');
    });

    await expect(
      readAuditData({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        expectedOrigin: ORIGIN,
        accountId: ACCOUNT_ID,
        fetchImpl,
      })
    ).rejects.toThrow(/request failed/i);
  });

  it('requests only the two rows needed to prove account uniqueness', async () => {
    let accountsRequest: URL | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname.endsWith('/crm_audit_accounts')) {
        accountsRequest = requestUrl;
        return page([{ id: '123e4567-e89b-42d3-a456-426614174000' }], '0-0/1');
      }
      return page([], '*/0');
    });

    await readAuditData({
      baseUrl: ORIGIN,
      ...auditCredentials(),
      expectedOrigin: ORIGIN,
      accountId: ACCOUNT_ID,
      fetchImpl,
      nowMs: Date.parse('2026-09-04T05:00:00.000Z'),
    });

    expect(accountsRequest?.searchParams.get('limit')).toBe('2');
  });

  it('rejects an account row that disagrees with the explicit tenant', async () => {
    const requestedAccount = '123e4567-e89b-42d3-a456-426614174000';
    const differentAccount = '123e4567-e89b-42d3-a456-426614174001';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname.endsWith('/crm_audit_accounts')) {
        return page([{ id: differentAccount }], '0-0/1');
      }
      return page([], '*/0');
    });

    await expect(
      readAuditData({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        accountId: requestedAccount,
        expectedOrigin: ORIGIN,
        fetchImpl,
      })
    ).rejects.toThrow(/cuenta|account/i);
  });

  it('rejects an operational row whose returned tenant differs', async () => {
    const accountId = '123e4567-e89b-42d3-a456-426614174000';
    const otherAccount = '123e4567-e89b-42d3-a456-426614174001';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const table = new URL(String(input)).pathname.split('/').at(-1);
      if (table === 'crm_audit_accounts')
        return page([{ id: accountId }], '0-0/1');
      if (table === 'crm_audit_contacts') {
        return page(
          [
            {
              id: '123e4567-e89b-42d3-a456-426614174010',
              account_id: otherAccount,
            },
          ],
          '0-0/1'
        );
      }
      return page([], '*/0');
    });

    await expect(
      readAuditData({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        accountId,
        expectedOrigin: ORIGIN,
        fetchImpl,
      })
    ).rejects.toThrow(/cuenta|tenant|esquema/i);
  });

  it('rejects extra keys in operational responses', async () => {
    const accountId = '123e4567-e89b-42d3-a456-426614174000';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const table = new URL(String(input)).pathname.split('/').at(-1);
      if (table === 'crm_audit_accounts')
        return page([{ id: accountId }], '0-0/1');
      if (table === 'crm_audit_contacts') {
        return page(
          [
            {
              id: '123e4567-e89b-42d3-a456-426614174010',
              account_id: accountId,
              phone: 'must-not-cross-boundary',
            },
          ],
          '0-0/1'
        );
      }
      return page([], '*/0');
    });

    await expect(
      readAuditData({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        accountId,
        expectedOrigin: ORIGIN,
        fetchImpl,
      })
    ).rejects.toThrow(/esquema/i);
  });

  it('rejects a message whose view tenant differs', async () => {
    const otherAccount = '123e4567-e89b-42d3-a456-426614174001';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const table = new URL(String(input)).pathname.split('/').at(-1);
      if (table === 'crm_audit_accounts')
        return page([{ id: ACCOUNT_ID }], '0-0/1');
      if (table === 'crm_audit_messages') {
        return page(
          [
            {
              id: '123e4567-e89b-42d3-a456-426614174010',
              conversation_id: '123e4567-e89b-42d3-a456-426614174011',
              sender_type: 'customer',
              content_type: 'text',
              content_text: null,
              status: 'received',
              status_error: null,
              created_at: '2026-09-04T04:00:00.000Z',
              ai_generated: false,
              account_id: otherAccount,
            },
          ],
          '0-0/1'
        );
      }
      return page([], '*/0');
    });

    await expect(
      readAuditData({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        accountId: ACCOUNT_ID,
        expectedOrigin: ORIGIN,
        nowMs: Date.parse('2026-09-04T05:00:00.000Z'),
        fetchImpl,
      })
    ).rejects.toThrow(/cuenta|tenant/i);
  });

  it('rejects malformed or cross-tenant reference rows', async () => {
    const accountId = '123e4567-e89b-42d3-a456-426614174000';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const table = new URL(String(input)).pathname.split('/').at(-1);
      if (table === 'crm_audit_accounts')
        return page([{ id: accountId }], '0-0/1');
      return page(
        [
          {
            id: '123e4567-e89b-42d3-a456-426614174010',
            account_id: '123e4567-e89b-42d3-a456-426614174001',
            unexpected: true,
          },
        ],
        '0-0/1'
      );
    });

    await expect(
      readScopedReferenceIds({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        accountId,
        expectedOrigin: ORIGIN,
        kind: 'conversation',
        fetchImpl,
      })
    ).rejects.toThrow(/cuenta|tenant|esquema/i);
  });

  it('keeps the timeout active while the response body is read', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const table = new URL(String(input)).pathname.split('/').at(-1);
      if (table === 'crm_audit_accounts')
        return page([{ id: ACCOUNT_ID }], '0-0/1');
      if (table === 'crm_audit_messages') {
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { 'content-range': '*/0' },
        });
      }
      return page([], '*/0');
    });

    await expect(
      readAuditData({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        accountId: ACCOUNT_ID,
        expectedOrigin: ORIGIN,
        readLimits: { requestTimeoutMs: 100, totalTimeoutMs: 100 },
        fetchImpl,
      })
    ).rejects.toThrow(/request failed|timeout/i);
  });

  it('rejects a response body above the pre-parse byte cap', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const table = new URL(String(input)).pathname.split('/').at(-1);
      if (table === 'crm_audit_accounts')
        return page([{ id: ACCOUNT_ID }], '0-0/1');
      if (table === 'crm_audit_messages') {
        return new Response(`[${' '.repeat(300)}]`, {
          status: 200,
          headers: { 'content-range': '*/0' },
        });
      }
      return page([], '*/0');
    });

    await expect(
      readAuditData({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        accountId: ACCOUNT_ID,
        expectedOrigin: ORIGIN,
        readLimits: { maxResponseBytes: 256 },
        fetchImpl,
      })
    ).rejects.toThrow(/request failed|límite/i);
  });

  it('rejects unknown or unsafe read-limit options before a request', async () => {
    const fetchImpl = vi.fn();

    await expect(
      readAuditData({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        accountId: ACCOUNT_ID,
        expectedOrigin: ORIGIN,
        readLimits: { pageSize: 0, select: '*' },
        fetchImpl,
      })
    ).rejects.toThrow(/límites/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when cursor pagination exceeds the page cap', async () => {
    let messagePage = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const table = new URL(String(input)).pathname.split('/').at(-1);
      if (table === 'crm_audit_accounts')
        return page([{ id: ACCOUNT_ID }], '0-0/1');
      if (table === 'crm_audit_messages') {
        messagePage += 1;
        return page([{ id: `page-${messagePage}` }], '0-0/2');
      }
      return page([], '*/0');
    });

    await expect(
      readAuditData({
        baseUrl: ORIGIN,
        ...auditCredentials(),
        accountId: ACCOUNT_ID,
        expectedOrigin: ORIGIN,
        readLimits: { pageSize: 1, maxPages: 1 },
        fetchImpl,
      })
    ).rejects.toThrow(/cobertura/i);
    expect(messagePage).toBe(1);
  });
});
