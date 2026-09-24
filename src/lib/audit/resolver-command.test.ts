import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { shortRef } from './crm-auditor.mjs';

import {
  loadEnvironment,
  openWithSystem,
  runResolver,
} from '../../../scripts/resolve-crm-audit-ref.mjs';

describe('runResolver', () => {
  const rawId = '123e4567-e89b-42d3-a456-426614174000';
  const referenceKey = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo';
  const reference = shortRef(rawId, referenceKey);
  const runtimeConfig = (uiOrigin: unknown = 'https://crm.example.com') => ({
    baseUrl: 'https://project.supabase.co',
    apiKey: 'synthetic-anon-key',
    accessToken: 'synthetic-auditor-token',
    referenceKey,
    expectedOrigin: 'https://project.supabase.co',
    accountId: rawId,
    uiOrigin,
  });

  it('opens the resolved same-origin route but returns only the opaque reference', async () => {
    const openUrl = vi.fn(async () => undefined);
    const result = await runResolver({
      argv: ['conversation', reference],
      loadConfig: () => runtimeConfig(),
      readIds: vi.fn(async () => [{ id: rawId }]),
      openUrl,
    });

    expect(openUrl).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith(
      `https://crm.example.com/inbox?c=${rawId}`
    );
    expect(result).toEqual({ opened: true, kind: 'conversation', reference });
    expect(JSON.stringify(result)).not.toContain(rawId);
  });

  it('validates the opaque request before reading configuration', async () => {
    const loadConfig = vi.fn(() => {
      throw new Error('must not run');
    });

    await expect(
      runResolver({
        argv: ['conversation', rawId],
        loadConfig,
        readIds: vi.fn(),
        openUrl: vi.fn(),
      })
    ).rejects.toThrow(/reference request/i);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('does not open anything when the reference is missing or ambiguous', async () => {
    const openUrl = vi.fn();

    await expect(
      runResolver({
        argv: ['conversation', reference],
        loadConfig: () => runtimeConfig(),
        readIds: vi.fn(async () => []),
        openUrl,
      })
    ).rejects.toThrow(/resolve reference/i);
    expect(openUrl).not.toHaveBeenCalled();
  });
  it.each([null, 'http://crm.example.com', 'https://crm.example.com/path'])(
    'rejects a missing or unsafe UI pin before reading IDs: %s',
    async (uiOrigin) => {
      const readIds = vi.fn(async () => [{ id: rawId }]);
      const openUrl = vi.fn();
      await expect(
        runResolver({
          argv: ['conversation', reference],
          loadConfig: () => runtimeConfig(uiOrigin),
          readIds,
          openUrl,
        })
      ).rejects.toThrow(/origin/i);
      expect(readIds).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalled();
    }
  );

  it('times out resolution and cannot open after a late response', async () => {
    vi.useFakeTimers();
    try {
      let complete!: (rows: { id: string }[]) => void;
      let observedSignal: AbortSignal | undefined;
      const openUrl = vi.fn();
      const pending = runResolver({
        argv: ['conversation', reference],
        loadConfig: () => runtimeConfig(),
        readIds: ({ signal }: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            observedSignal = signal;
            complete = resolve;
          }),
        openUrl,
      });
      const rejected = expect(pending).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(90_001);
      await rejected;
      expect(observedSignal?.aborted).toBe(true);
      complete([{ id: rawId }]);
      await Promise.resolve();
      expect(openUrl).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('loadEnvironment', () => {
  it('uses only the dedicated anchored audit file', () => {
    const projectRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-config-'))
    );
    try {
      fs.writeFileSync(
        path.join(projectRoot, '.crm-audit.env'),
        [
          'CRM_AUDIT_SUPABASE_URL=https://project.supabase.co',
          'CRM_AUDIT_API_KEY=synthetic-anon',
          'CRM_AUDIT_ACCESS_TOKEN=synthetic-auditor',
          'CRM_AUDIT_ACCOUNT_ID=123e4567-e89b-42d3-a456-426614174000',
          'CRM_AUDIT_REFERENCE_KEY=WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo',
          'CRM_AUDIT_HISTORY_DAYS=90',
        ].join('\n') + '\n',
        { mode: 0o600 }
      );
      fs.writeFileSync(
        path.join(projectRoot, '.env'),
        'SUPABASE_SERVICE_ROLE_KEY=must-not-be-read\n',
        { mode: 0o600 }
      );
      for (const key of Object.keys(process.env)) {
        if (
          /^(NODE_|DYLD_|LD_|.*PROXY$|SSL_|OPENSSL_|.*CA_BUNDLE$|GRPC_DEFAULT_SSL_ROOTS_FILE)/i.test(
            key
          )
        ) {
          vi.stubEnv(key, undefined);
        }
      }
      vi.stubEnv('CRM_AUDIT_HISTORY_DAYS', '1');
      const config = loadEnvironment({ projectRoot }) as Record<string, string>;
      expect(config.CRM_AUDIT_HISTORY_DAYS).toBe('90');
      expect(config).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY');
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('openWithSystem', () => {
  it('uses a bounded absolute opener with no shell or inherited environment', () => {
    const spawnImpl = vi.fn(() => ({
      status: 0,
      pid: 0,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      signal: null,
    }));
    openWithSystem('https://crm.example.com/inbox', spawnImpl);
    expect(spawnImpl).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['https://crm.example.com/inbox'],
      {
        stdio: 'ignore',
        shell: false,
        env: {},
        timeout: 5_000,
        killSignal: 'SIGKILL',
      }
    );
  });
});
