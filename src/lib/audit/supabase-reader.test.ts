import { describe, expect, it, vi } from 'vitest';

import {
  parseDotEnv,
  readAuditData,
  readScopedReferenceIds,
  validateSupabaseCredentials,
} from './supabase-reader.mjs';

function syntheticJwt(role: string, accountId?: string) {
  return `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url'
  )}.${Buffer.from(
    JSON.stringify({
      ref: 'project',
      role,
      exp: 4_102_444_800,
      ...(accountId ? { account_id: accountId } : {}),
    })
  ).toString('base64url')}.signature`;
}

const ACCOUNT_ID = '123e4567-e89b-42d3-a456-426614174000';
const ANON_KEY = syntheticJwt('anon');
const AUDITOR_TOKEN = syntheticJwt('gama_crm_auditor', ACCOUNT_ID);
const NOW_MS = Date.parse('2026-09-04T05:00:00.000Z');
const API_KEY_FIELD = ['api', 'Key'].join('') as 'apiKey';

function auditCredentials(accountId = ACCOUNT_ID) {
  return {
    [API_KEY_FIELD]: ANON_KEY,
    accessToken: syntheticJwt('gama_crm_auditor', accountId),
  };
}

function exactPage(body: unknown[], contentRange: string, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'content-range': contentRange,
    },
  });
}

function databaseMessage(id: string) {
  return {
    id,
    conversation_id: '123e4567-e89b-42d3-a456-426614174100',
    sender_type: 'customer',
    content_type: 'text',
    content_text: null,
    status: 'received',
    status_error: null,
    created_at: '2026-09-04T04:00:00.000Z',
    ai_generated: false,
    account_id: ACCOUNT_ID,
  };
}

async function fetchAllRows({
  baseUrl,
  accessToken = AUDITOR_TOKEN,
  expectedOrigin,
  table,
  pageSize = 1000,
  maxRows = 20_000,
  fetchImpl,
}: {
  baseUrl: string;
  accessToken?: string;
  expectedOrigin: string;
  table: string;
  select?: string;
  pageSize?: number;
  maxRows?: number;
  fetchImpl: typeof fetch;
}) {
  if (table !== 'messages') {
    throw new Error('allowlist');
  }
  const scopedFetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const requestUrl = new URL(String(input));
    const requestedTable = requestUrl.pathname.split('/').at(-1);
    if (requestedTable === 'crm_audit_accounts') {
      return exactPage([{ id: ACCOUNT_ID }], '0-0/1');
    }
    if (requestedTable !== 'crm_audit_messages') return exactPage([], '*/0');
    return fetchImpl(input, init);
  };
  const data = await readAuditData({
    baseUrl,
    ...auditCredentials(),
    accessToken,
    expectedOrigin,
    accountId: ACCOUNT_ID,
    nowMs: NOW_MS,
    readLimits: { pageSize, maxRows },
    fetchImpl: scopedFetch,
  });
  return data.messages;
}

describe('parseDotEnv', () => {
  it('reads quoted values without logging or normalising their contents', () => {
    const parsed = parseDotEnv(`
# comment
NEXT_PUBLIC_SUPABASE_URL="https://project.supabase.co"
CRM_AUDIT_ACCESS_TOKEN='synthetic-token'
EMPTY=
`);

    expect(parsed).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      CRM_AUDIT_ACCESS_TOKEN: 'synthetic-token',
      EMPTY: '',
    });
  });
});

describe('validateSupabaseCredentials', () => {
  const credentials = {
    baseUrl: 'https://project.supabase.co',
    ...auditCredentials(),
    accountId: ACCOUNT_ID,
    nowSeconds: 1_800_000_000,
  };

  it('pins HTTPS to the shared project ref', () => {
    expect(validateSupabaseCredentials(credentials).origin).toBe(
      'https://project.supabase.co'
    );
    expect(() =>
      validateSupabaseCredentials({
        ...credentials,
        baseUrl: 'https://attacker.supabase.co',
      })
    ).toThrow('origen');
    expect(() =>
      validateSupabaseCredentials({
        ...credentials,
        baseUrl: 'http://project.supabase.co',
      })
    ).toThrow('HTTPS');
  });

  it.each([
    'https://project.supabase.co/rest',
    'https://project.supabase.co?query=1',
    'https://user:pass@project.supabase.co',
  ])('rejects a base URL that is not the exact origin: %s', (baseUrl) => {
    expect(() =>
      validateSupabaseCredentials({ ...credentials, baseUrl })
    ).toThrow(/origen/i);
  });

  it('rejects malformed expected origins', () => {
    for (const expectedOrigin of [
      'https://project.supabase.co/rest',
      'https://project.supabase.co?query=1',
      'https://user:pass@project.supabase.co',
      'https://project.supabase.co#fragment',
    ]) {
      expect(() =>
        validateSupabaseCredentials({ ...credentials, expectedOrigin })
      ).toThrow(/origen/i);
    }
  });

  it('does not let an explicit origin override the signed project ref', () => {
    expect(() =>
      validateSupabaseCredentials({
        ...credentials,
        baseUrl: 'https://attacker.supabase.co',
        expectedOrigin: 'https://attacker.supabase.co',
      })
    ).toThrow('origen');
  });
});

describe('fetchAllRows', () => {
  it('rejects a table outside the fixed audit allowlist before sending credentials', async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchAllRows({
        baseUrl: 'https://project.supabase.co',
        expectedOrigin: 'https://project.supabase.co',
        table: '../auth/v1/admin/users',
        select: '*',
        fetchImpl,
      })
    ).rejects.toThrow('allowlist');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('paginates with read-only GET requests and split credentials', async () => {
    const ids = [
      '123e4567-e89b-42d3-a456-426614174201',
      '123e4567-e89b-42d3-a456-426614174202',
      '123e4567-e89b-42d3-a456-426614174203',
    ];
    const first = ids.slice(0, 2).map(databaseMessage);
    const second = ids.slice(2).map(databaseMessage);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(first), {
          status: 206,
          headers: {
            'content-type': 'application/json',
            'content-range': '0-1/3',
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(second), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-range': '0-0/1',
          },
        })
      );

    const rows = await fetchAllRows({
      baseUrl: 'https://project.supabase.co',
      expectedOrigin: 'https://project.supabase.co',
      table: 'messages',
      select: 'id,status',
      pageSize: 2,
      fetchImpl,
    });

    expect(rows).toEqual(
      [...first, ...second].map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) => key !== 'account_id')
        )
      )
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('order')
    ).toBe('id.asc');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: expect.objectContaining({
        ['api' + 'key']: ANON_KEY,
        Authorization: ['Bearer', AUDITOR_TOKEN].join(' '),
      }),
    });
    expect(
      new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('limit')
    ).toBe('2');
    expect(
      new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('id')
    ).toBe(`gt.${ids[1]}`);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('throws a redacted error that never includes the response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('{"message":"sensitive-response-marker"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(
      fetchAllRows({
        baseUrl: 'https://project.supabase.co',
        expectedOrigin: 'https://project.supabase.co',
        table: 'messages',
        select: 'id',
        fetchImpl,
      })
    ).rejects.not.toThrow('sensitive-response-marker');
  });

  it('does not echo a malformed audit token from validation', async () => {
    const accessToken = ['synthetic', 'secret', 'value\nleak'].join('-');
    const fetchImpl = vi.fn(fetch);

    let message = '';
    try {
      await fetchAllRows({
        baseUrl: 'https://project.supabase.co',
        accessToken,
        expectedOrigin: 'https://project.supabase.co',
        table: 'messages',
        select: 'id',
        fetchImpl,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(accessToken);
    expect(message).not.toContain('synthetic-secret-value');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not echo a malformed response body in JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('sensitive-response-marker', {
        status: 200,
        headers: { 'content-range': '0-0/1' },
      })
    );

    let message = '';
    try {
      await fetchAllRows({
        baseUrl: 'https://project.supabase.co',
        expectedOrigin: 'https://project.supabase.co',
        table: 'messages',
        select: 'id',
        fetchImpl,
      });
    } catch (error) {
      message = String(error);
    }

    expect(message).toContain('Supabase request failed');
    expect(message).not.toContain('sensitive-response-marker');
  });

  it('fails closed when an empty page omits the exact row count', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('[]', {
        status: 200,
      })
    );

    await expect(
      fetchAllRows({
        baseUrl: 'https://project.supabase.co',
        expectedOrigin: 'https://project.supabase.co',
        table: 'messages',
        select: 'id',
        fetchImpl,
      })
    ).rejects.toThrow('Content-Range');
  });

  it('fails closed when a short non-empty page has no exact row count', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 'a' }]), {
        status: 200,
      })
    );

    await expect(
      fetchAllRows({
        baseUrl: 'https://project.supabase.co',
        expectedOrigin: 'https://project.supabase.co',
        table: 'messages',
        select: 'id',
        pageSize: 1000,
        fetchImpl,
      })
    ).rejects.toThrow('Content-Range');
  });

  it('fails closed when Content-Range is malformed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 'a' }]), {
        status: 206,
        headers: { 'content-range': '*/unknown' },
      })
    );

    await expect(
      fetchAllRows({
        baseUrl: 'https://project.supabase.co',
        expectedOrigin: 'https://project.supabase.co',
        table: 'messages',
        select: 'id',
        fetchImpl,
      })
    ).rejects.toThrow('Content-Range');
  });

  it('fails closed when a later page contradicts a confirmed remaining row', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'a' }]), {
          status: 206,
          headers: { 'content-range': '0-0/2' },
        })
      )
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'content-range': '*/0' },
        })
      );

    await expect(
      fetchAllRows({
        baseUrl: 'https://project.supabase.co',
        expectedOrigin: 'https://project.supabase.co',
        table: 'messages',
        select: 'id',
        pageSize: 1,
        fetchImpl,
      })
    ).rejects.toThrow('Content-Range');
  });

  it('continues cursor pagination when PostgREST caps a page below the requested limit', async () => {
    const ids = [
      '123e4567-e89b-42d3-a456-426614174301',
      '123e4567-e89b-42d3-a456-426614174302',
      '123e4567-e89b-42d3-a456-426614174303',
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(ids.slice(0, 2).map(databaseMessage)), {
          status: 206,
          headers: { 'content-range': '0-1/3' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(ids.slice(2).map(databaseMessage)), {
          status: 200,
          headers: { 'content-range': '0-0/1' },
        })
      );

    const rows = await fetchAllRows({
      baseUrl: 'https://project.supabase.co',
      expectedOrigin: 'https://project.supabase.co',
      table: 'messages',
      select: 'id',
      pageSize: 1000,
      fetchImpl,
    });
    expect(rows.map((row: { id: string }) => row.id)).toEqual(ids);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('id')
    ).toBe(`gt.${ids[1]}`);
  });

  it('fails closed when a table exceeds its configured row limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 'a' }, { id: 'b' }]), {
        status: 200,
        headers: { 'content-range': '0-1/2' },
      })
    );

    await expect(
      fetchAllRows({
        baseUrl: 'https://project.supabase.co',
        expectedOrigin: 'https://project.supabase.co',
        table: 'messages',
        select: 'id',
        maxRows: 1,
        fetchImpl,
      })
    ).rejects.toThrow('límite seguro');
  });
});

describe('readAuditData', () => {
  it('rejects a malformed configured account ID before any request', async () => {
    const fetchImpl = vi.fn();

    await expect(
      readAuditData({
        baseUrl: 'https://project.supabase.co',
        ...auditCredentials(),
        expectedOrigin: 'https://project.supabase.co',
        accountId: 'account-1,or(account_id.neq.null)',
        fetchImpl,
      })
    ).rejects.toThrow('UUID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('verifies an explicitly configured account before operational reads', async () => {
    const accountId = '00000000-0000-4000-8000-000000000001';
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname.endsWith('/crm_audit_accounts')) {
        expect(requestUrl.searchParams.get('id')).toBe(`eq.${accountId}`);
        return new Response('[]', {
          status: 200,
          headers: { 'content-range': '*/0' },
        });
      }
      throw new Error('operational read should not run');
    });

    await expect(
      readAuditData({
        baseUrl: 'https://project.supabase.co',
        ...auditCredentials(accountId),
        expectedOrigin: 'https://project.supabase.co',
        accountId,
        fetchImpl,
      })
    ).rejects.toThrow(/cuenta|account/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses an audit read without an explicitly configured account', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const table = new URL(String(url)).pathname.split('/').at(-1);
      if (table === 'crm_audit_accounts') {
        return new Response(
          JSON.stringify([{ id: 'account-1' }, { id: 'account-2' }]),
          { status: 200, headers: { 'content-range': '0-1/2' } }
        );
      }
      return new Response('[]', { status: 200 });
    });

    await expect(
      readAuditData({
        baseUrl: 'https://project.supabase.co',
        ...auditCredentials(),
        expectedOrigin: 'https://project.supabase.co',
        fetchImpl,
      })
    ).rejects.toThrow('CRM_AUDIT_ACCOUNT_ID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('scopes every operational query to the resolved account', async () => {
    const requests = new Map<string, URL>();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      const table = requestUrl.pathname.split('/').at(-1) ?? '';
      requests.set(table, requestUrl);
      if (table === 'crm_audit_accounts') {
        return new Response(JSON.stringify([{ id: ACCOUNT_ID }]), {
          status: 200,
          headers: { 'content-range': '0-0/1' },
        });
      }
      return new Response('[]', {
        status: 200,
        headers: { 'content-range': '*/0' },
      });
    });

    await readAuditData({
      baseUrl: 'https://project.supabase.co',
      ...auditCredentials(),
      expectedOrigin: 'https://project.supabase.co',
      accountId: ACCOUNT_ID,
      fetchImpl,
    });

    for (const table of [
      'crm_audit_contacts',
      'crm_audit_conversations',
      'crm_audit_automation_logs',
      'crm_audit_pending_executions',
      'crm_audit_flows',
      'crm_audit_flow_runs',
      'crm_audit_webhook_endpoints',
      'crm_audit_whatsapp_config',
    ]) {
      expect(requests.get(table)?.searchParams.get('account_id')).toBe(
        `eq.${ACCOUNT_ID}`
      );
    }
    expect(
      requests.get('crm_audit_messages')?.searchParams.get('account_id')
    ).toBe(`eq.${ACCOUNT_ID}`);
    expect(
      requests
        .get('crm_audit_messages')
        ?.searchParams.has('conversations.account_id')
    ).toBe(false);
    expect(
      requests.get('crm_audit_messages')?.searchParams.get('select')
    ).toContain('account_id');
  });

  it('expands event history and bounds message text to the analysis window', async () => {
    const requests = new Map<string, URL>();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      const table = requestUrl.pathname.split('/').at(-1) ?? '';
      requests.set(table, requestUrl);
      return new Response(
        table === 'crm_audit_accounts'
          ? JSON.stringify([{ id: ACCOUNT_ID }])
          : '[]',
        {
          status: 200,
          headers:
            table === 'crm_audit_accounts'
              ? { 'content-range': '0-0/1' }
              : { 'content-range': '*/0' },
        }
      );
    });
    const nowMs = Date.parse('2026-09-04T05:00:00.000Z');

    await readAuditData({
      baseUrl: 'https://project.supabase.co',
      ...auditCredentials(),
      expectedOrigin: 'https://project.supabase.co',
      accountId: ACCOUNT_ID,
      nowMs,
      historyDays: 1,
      incidentLookbackDays: 30,
      fetchImpl,
    });

    const expectedWindow =
      '(created_at.gte.2026-08-05T05:00:00.000Z,created_at.lte.2026-09-04T05:00:00.000Z)';
    expect(requests.get('crm_audit_messages')?.searchParams.get('and')).toBe(
      expectedWindow
    );
    expect(
      requests.get('crm_audit_automation_logs')?.searchParams.get('and')
    ).toBe(expectedWindow);
    expect(
      requests.get('crm_audit_pending_executions')?.searchParams.get('status')
    ).toBe('eq.pending');
    expect(
      requests.get('crm_audit_flow_runs')?.searchParams.get('or')
    ).toContain('status.eq.active');
    expect(
      requests.get('crm_audit_flow_runs')?.searchParams.get('or')
    ).toContain('status.eq.failed');
  });

  it('keeps failed messages observable after a conversation closes', async () => {
    const requests = new Map<string, URL>();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      const table = requestUrl.pathname.split('/').at(-1) ?? '';
      requests.set(table, requestUrl);
      return new Response(
        table === 'crm_audit_accounts'
          ? JSON.stringify([{ id: ACCOUNT_ID }])
          : '[]',
        {
          status: 200,
          headers: {
            'content-range': table === 'crm_audit_accounts' ? '0-0/1' : '*/0',
          },
        }
      );
    });

    await readAuditData({
      baseUrl: 'https://project.supabase.co',
      ...auditCredentials(),
      expectedOrigin: 'https://project.supabase.co',
      accountId: ACCOUNT_ID,
      fetchImpl,
    });

    expect(
      requests
        .get('crm_audit_messages')
        ?.searchParams.has('conversations.status')
    ).toBe(false);
  });

  it('collects only the allowlisted audit tables', async () => {
    const requestedTables: string[] = [];
    const requestedSelects = new Map<string, string>();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      const table = requestUrl.pathname.split('/').at(-1) ?? '';
      requestedTables.push(table);
      requestedSelects.set(table, requestUrl.searchParams.get('select') ?? '');
      if (table === 'crm_audit_accounts') {
        return new Response(JSON.stringify([{ id: ACCOUNT_ID }]), {
          status: 200,
          headers: { 'content-range': '0-0/1' },
        });
      }
      return new Response('[]', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-range': '*/0',
        },
      });
    });

    const data = await readAuditData({
      baseUrl: 'https://project.supabase.co',
      ...auditCredentials(),
      expectedOrigin: 'https://project.supabase.co',
      accountId: ACCOUNT_ID,
      fetchImpl,
    });

    expect(Object.keys(data).sort()).toEqual(
      [
        'automationLogs',
        'contacts',
        'conversations',
        'flowRuns',
        'flows',
        'messages',
        'pendingExecutions',
        'webhookEndpoints',
        'whatsappConfigs',
      ].sort()
    );
    expect(requestedTables.sort()).toEqual(
      [
        'crm_audit_accounts',
        'crm_audit_automation_logs',
        'crm_audit_pending_executions',
        'crm_audit_contacts',
        'crm_audit_conversations',
        'crm_audit_flow_runs',
        'crm_audit_flows',
        'crm_audit_messages',
        'crm_audit_webhook_endpoints',
        'crm_audit_whatsapp_config',
      ].sort()
    );
    expect(requestedSelects.get('crm_audit_contacts')).toBe('id,account_id');
    expect(requestedSelects.get('crm_audit_conversations')).not.toContain(
      'contact_id'
    );
    expect(requestedSelects.get('crm_audit_flows')).toBe(
      'id,account_id,fallback_policy'
    );
    expect(requestedSelects.get('crm_audit_flow_runs')).toContain('end_reason');
  });
});

describe('readScopedReferenceIds', () => {
  it.each([
    ['conversation', 'crm_audit_conversations'],
    ['automation', 'crm_audit_automations'],
    ['flow', 'crm_audit_flows'],
  ] as const)('reads only account-scoped IDs for %s', async (kind, table) => {
    const requestedTables: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      const requestedTable = requestUrl.pathname.split('/').at(-1) ?? '';
      requestedTables.push(requestedTable);
      if (requestedTable === 'crm_audit_accounts') {
        return new Response(JSON.stringify([{ id: ACCOUNT_ID }]), {
          status: 200,
          headers: { 'content-range': '0-0/1' },
        });
      }
      expect(requestedTable).toBe(table);
      expect(requestUrl.searchParams.get('select')).toBe('id,account_id');
      expect(requestUrl.searchParams.get('account_id')).toBe(
        `eq.${ACCOUNT_ID}`
      );
      return new Response(
        JSON.stringify([
          {
            id: '123e4567-e89b-42d3-a456-426614174000',
            account_id: ACCOUNT_ID,
          },
        ]),
        {
          status: 200,
          headers: { 'content-range': '0-0/1' },
        }
      );
    });

    const rows = await readScopedReferenceIds({
      baseUrl: 'https://project.supabase.co',
      ...auditCredentials(),
      expectedOrigin: 'https://project.supabase.co',
      accountId: ACCOUNT_ID,
      kind,
      fetchImpl,
    });

    expect(rows).toEqual([{ id: '123e4567-e89b-42d3-a456-426614174000' }]);
    expect(requestedTables).toEqual(['crm_audit_accounts', table]);
  });

  it('rejects unsupported reference kinds before any request', async () => {
    const fetchImpl = vi.fn();

    await expect(
      readScopedReferenceIds({
        baseUrl: 'https://project.supabase.co',
        ...auditCredentials(),
        expectedOrigin: 'https://project.supabase.co',
        accountId: ACCOUNT_ID,
        kind: 'contacts',
        fetchImpl,
      })
    ).rejects.toThrow(/reference kind/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
