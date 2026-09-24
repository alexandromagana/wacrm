import { describe, expect, it, vi } from 'vitest';

import {
  readAuditData,
  validateSupabaseCredentials,
} from './supabase-reader.mjs';

const ACCOUNT_ID = '123e4567-e89b-42d3-a456-426614174000';
const ORIGIN = 'https://project.supabase.co';

function jwt(payload: Record<string, unknown>) {
  return `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url'
  )}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

const API_KEY = jwt({
  iss: 'supabase',
  ref: 'project',
  role: 'anon',
  iat: 1_700_000_000,
  exp: 4_102_444_800,
});
const ACCESS_TOKEN = jwt({
  iss: 'supabase',
  ref: 'project',
  role: 'gama_crm_auditor',
  account_id: ACCOUNT_ID,
  iat: 1_700_000_000,
  exp: 4_102_444_800,
});

function page(body: unknown[], contentRange = '*/0') {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-range': contentRange,
      'content-type': 'application/json',
    },
  });
}

describe('dedicated read-only Supabase credentials', () => {
  it('pins the origin to matching anon and audit JWTs for one account', () => {
    expect(
      validateSupabaseCredentials({
        baseUrl: ORIGIN,
        apiKey: API_KEY,
        accessToken: ACCESS_TOKEN,
        accountId: ACCOUNT_ID,
      })
    ).toEqual({ origin: ORIGIN, accountId: ACCOUNT_ID });
  });

  it.each([
    [
      'service role bearer',
      API_KEY,
      jwt({ ref: 'project', role: 'service_role', account_id: ACCOUNT_ID }),
      ACCOUNT_ID,
    ],
    [
      'wrong account',
      API_KEY,
      jwt({
        ref: 'project',
        role: 'gama_crm_auditor',
        account_id: '123e4567-e89b-42d3-a456-426614174001',
        exp: 4_102_444_800,
      }),
      ACCOUNT_ID,
    ],
    [
      'wrong project',
      API_KEY,
      jwt({
        ref: 'other-project',
        role: 'gama_crm_auditor',
        account_id: ACCOUNT_ID,
        exp: 4_102_444_800,
      }),
      ACCOUNT_ID,
    ],
    [
      'service role api key',
      jwt({ ref: 'project', role: 'service_role', exp: 4_102_444_800 }),
      ACCESS_TOKEN,
      ACCOUNT_ID,
    ],
    [
      'expired audit token',
      API_KEY,
      jwt({
        ref: 'project',
        role: 'gama_crm_auditor',
        account_id: ACCOUNT_ID,
        exp: 1,
      }),
      ACCOUNT_ID,
    ],
  ])(
    'rejects %s before network access',
    (_label, apiKey, accessToken, accountId) => {
      expect(() =>
        validateSupabaseCredentials({
          baseUrl: ORIGIN,
          apiKey,
          accessToken,
          accountId,
          nowSeconds: 2_000_000_000,
        })
      ).toThrow(/credencial|token|cuenta|proyecto/i);
    }
  );

  it('uses only GET against prefixed audit views with split credentials', async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        void init;
        const url = new URL(String(input));
        if (url.pathname.endsWith('/crm_audit_accounts')) {
          return page([{ id: ACCOUNT_ID }], '0-0/1');
        }
        return page([]);
      }
    );

    await readAuditData({
      baseUrl: ORIGIN,
      apiKey: API_KEY,
      accessToken: ACCESS_TOKEN,
      accountId: ACCOUNT_ID,
      nowMs: Date.parse('2026-09-04T05:00:00.000Z'),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalled();
    for (const [input, init] of fetchImpl.mock.calls) {
      const url = new URL(String(input));
      expect(url.pathname).toMatch(/^\/rest\/v1\/crm_audit_[a-z_]+$/);
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        headers: expect.objectContaining({
          apikey: API_KEY,
          Authorization: `Bearer ${ACCESS_TOKEN}`,
        }),
      });
      expect(String(input)).not.toContain('service_role');
    }
  });
});
