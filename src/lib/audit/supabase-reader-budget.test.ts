import { describe, expect, it, vi } from 'vitest';
import { readAuditData, readScopedReferenceIds } from './supabase-reader.mjs';
const accountId = '123e4567-e89b-42d3-a456-426614174000';
const baseUrl = 'https://project.supabase.co';
const jwt = (role: string, includeAccount = false) =>
  `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
    JSON.stringify({
      role,
      ref: 'project',
      exp: 4_102_444_800,
      ...(includeAccount ? { account_id: accountId } : {}),
    })
  ).toString('base64url')}.signature`;
const config = {
  accountId,
  baseUrl,
  apiKey: jwt('anon'),
  accessToken: jwt('gama_crm_auditor', true),
};

const account = () =>
  new Response(JSON.stringify([{ id: accountId }]), {
    headers: { 'Content-Range': '0-0/1' },
  });

describe('shared transport budget', () => {
  it.each(['select', 'table', 'filters', 'method'])(
    'rejects unexpected public option %s before IO',
    async (key) => {
      const fetchImpl = vi.fn(async () => account());
      await expect(
        readAuditData({ ...config, fetchImpl, [key]: 'untrusted' })
      ).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );
  it('validates resolver limits before its account lookup', async () => {
    const fetchImpl = vi.fn(async () => account());
    await expect(
      readScopedReferenceIds({
        ...config,
        kind: 'conversation',
        fetchImpl,
        readLimits: { maxPages: Infinity },
      })
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('aborts sibling queries when one source fails', async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        );
        if (url.pathname.endsWith('/crm_audit_accounts')) return account();
        signals.push(init!.signal as AbortSignal);
        if (url.pathname.endsWith('/crm_audit_contacts'))
          return new Response('', { status: 500 });
        return await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true }
          );
        });
      }
    );
    await expect(readAuditData({ ...config, fetchImpl })).rejects.toThrow();
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it('includes account lookup in the shared deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
      const pending = readAuditData({
        ...config,
        fetchImpl,
        readLimits: { totalTimeoutMs: 100, requestTimeoutMs: 100 },
      });
      const rejected = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(101);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an oversized declared body before starting operational reads', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: accountId }]), {
          headers: {
            'content-range': '0-0/1',
            'content-length': '2000001',
          },
        })
    );
    await expect(readAuditData({ ...config, fetchImpl })).rejects.toThrow(
      /request failed/i
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honours an external resolver abort before any request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();

    await expect(
      readScopedReferenceIds({
        ...config,
        kind: 'conversation',
        signal: controller.signal,
        fetchImpl,
      })
    ).rejects.toThrow(/aborted|abortada/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
