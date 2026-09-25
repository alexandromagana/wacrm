import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as runtimeConfig from './local-runtime-config.mjs';

const { loadDedicatedAuditEnvironment } = runtimeConfig;

const roots: string[] = [];
const REFERENCE_KEY = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo';
const REQUIRED = [
  'CRM_AUDIT_SUPABASE_URL=https://project.supabase.co',
  'CRM_AUDIT_API_KEY=synthetic-anon',
  'CRM_AUDIT_ACCESS_TOKEN=synthetic-auditor',
  'CRM_AUDIT_ACCOUNT_ID=123e4567-e89b-42d3-a456-426614174000',
  `CRM_AUDIT_REFERENCE_KEY=${REFERENCE_KEY}`,
];

function rootWith(lines = REQUIRED) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'gama-audit-dedicated-'))
  );
  roots.push(root);
  fs.writeFileSync(path.join(root, '.crm-audit.env'), lines.join('\n') + '\n', {
    mode: 0o600,
  });
  return root;
}

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (
      /^(NODE_|DYLD_|LD_|.*PROXY$|SSL_|OPENSSL_|.*CA_BUNDLE$|GRPC_DEFAULT_SSL_ROOTS_FILE)/i.test(
        key
      )
    ) {
      vi.stubEnv(key, undefined);
    }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('loadDedicatedAuditEnvironment', () => {
  it('exports no legacy privileged-environment loader', () => {
    expect(Object.keys(runtimeConfig)).toEqual([
      'loadDedicatedAuditEnvironment',
    ]);
  });

  it('keeps the dedicated credential file out of version control', () => {
    const gitignore = fs.readFileSync(
      path.resolve(process.cwd(), '.gitignore'),
      'utf8'
    );

    expect(gitignore.split(/\r?\n/)).toContain('.crm-audit.env');
  });

  it('loads only the isolated read-only credential set', () => {
    const root = rootWith([...REQUIRED, 'CRM_AUDIT_HISTORY_DAYS=90']);
    fs.writeFileSync(
      path.join(root, '.env'),
      'SUPABASE_SERVICE_ROLE_KEY=must-not-be-read\n',
      { mode: 0o600 }
    );
    const opened: string[] = [];
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      opened.push(String(file));
      return open(file, ...args);
    });

    expect(loadDedicatedAuditEnvironment({ projectRoot: root })).toEqual({
      CRM_AUDIT_SUPABASE_URL: 'https://project.supabase.co',
      CRM_AUDIT_API_KEY: 'synthetic-anon',
      CRM_AUDIT_ACCESS_TOKEN: 'synthetic-auditor',
      CRM_AUDIT_ACCOUNT_ID: '123e4567-e89b-42d3-a456-426614174000',
      CRM_AUDIT_REFERENCE_KEY: REFERENCE_KEY,
      CRM_AUDIT_HISTORY_DAYS: '90',
    });
    expect(opened).toEqual([path.join(root, '.crm-audit.env')]);
  });

  it('fails closed when the dedicated file is absent', () => {
    const root = rootWith();
    fs.rmSync(path.join(root, '.crm-audit.env'));
    expect(() => loadDedicatedAuditEnvironment({ projectRoot: root })).toThrow(
      /dedicado|configuración/i
    );
  });

  it('rejects unknown keys instead of silently importing them', () => {
    const root = rootWith([...REQUIRED, 'SUPABASE_SERVICE_ROLE_KEY=forbidden']);
    expect(() => loadDedicatedAuditEnvironment({ projectRoot: root })).toThrow(
      /no permitida/i
    );
  });

  it('requires every read-only credential exactly once', () => {
    const root = rootWith(REQUIRED.slice(0, -1));
    expect(() => loadDedicatedAuditEnvironment({ projectRoot: root })).toThrow(
      /incompleta/i
    );
  });

  it('rejects a reference key that is not canonical base64url for 32 bytes', () => {
    const root = rootWith([
      ...REQUIRED.slice(0, -1),
      'CRM_AUDIT_REFERENCE_KEY=synthetic-reference',
    ]);

    expect(() => loadDedicatedAuditEnvironment({ projectRoot: root })).toThrow(
      /reference key/i
    );
  });

  it('rejects a symlinked or writable credential file', () => {
    const root = rootWith();
    const configPath = path.join(root, '.crm-audit.env');
    fs.chmodSync(configPath, 0o644);
    expect(() => loadDedicatedAuditEnvironment({ projectRoot: root })).toThrow(
      /archivo de entorno/i
    );
  });

  it.each([
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_USE_ENV_PROXY',
    'HTTP_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'no_proxy',
    'FTP_PROXY',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS',
    'NODE_USE_SYSTEM_CA',
    'NODE_USE_OPENSSL_CA',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'OPENSSL_CONF',
    'OPENSSL_MODULES',
    'CURL_CA_BUNDLE',
    'REQUESTS_CA_BUNDLE',
    'GRPC_DEFAULT_SSL_ROOTS_FILE',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'DYLD_FUTURE_OPTION',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
  ])('rejects inherited %s before touching the capability file', (key) => {
    const root = rootWith();
    vi.stubEnv(key, '');
    const open = vi.spyOn(fs, 'openSync');
    expect(() => loadDedicatedAuditEnvironment({ projectRoot: root })).toThrow(
      /env -i/
    );
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    'CRM_AUDIT_AWAITING_CONVERSATIONS',
    'CRM_AUDIT_RECENT_CONVERSATIONS',
    'CRM_AUDIT_MESSAGES_PER_CONVERSATION',
    'CRM_AUDIT_TECHNICAL_INCIDENTS',
  ])('rejects obsolete output cap %s in file and runtime', (key) => {
    const root = rootWith([...REQUIRED, `${key}=1`]);
    expect(() => loadDedicatedAuditEnvironment({ projectRoot: root })).toThrow(
      /límite.*fijo/i
    );
    fs.writeFileSync(
      path.join(root, '.crm-audit.env'),
      `${REQUIRED.join('\n')}\n`,
      { mode: 0o600 }
    );
    vi.stubEnv(key, '');
    expect(() => loadDedicatedAuditEnvironment({ projectRoot: root })).toThrow(
      /límite.*fijo/i
    );
  });

  it('rejects repeated keys rather than selecting the last value', () => {
    const root = rootWith([
      ...REQUIRED,
      'CRM_AUDIT_HISTORY_DAYS=90',
      'export CRM_AUDIT_HISTORY_DAYS=30',
    ]);
    expect(() => loadDedicatedAuditEnvironment({ projectRoot: root })).toThrow(
      /duplicad/i
    );
  });

  it('rejects a capability file not owned by the current user', () => {
    const root = rootWith();
    const fstat = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementationOnce(
      (...args: Parameters<typeof fs.fstatSync>) => {
        const stat = fstat(...args);
        return {
          ...stat,
          uid: Number(process.getuid?.() ?? stat.uid) + 1,
          isFile: () => true,
        } as fs.Stats;
      }
    );
    expect(() => loadDedicatedAuditEnvironment({ projectRoot: root })).toThrow(
      /archivo de entorno/i
    );
  });

  it('bounds reads even if the capability file grows after fstat', () => {
    const root = rootWith();
    const file = path.join(root, '.crm-audit.env');
    const fstat = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementationOnce(
      (...args: Parameters<typeof fs.fstatSync>) => {
        const stat = fstat(...args);
        fs.appendFileSync(file, 'x'.repeat(100_000));
        return stat;
      }
    );
    const unboundedRead = vi.spyOn(fs, 'readFileSync');
    const read = vi.spyOn(fs, 'readSync');
    const close = vi.spyOn(fs, 'closeSync');
    expect(() => loadDedicatedAuditEnvironment({ projectRoot: root })).toThrow(
      /archivo de entorno/i
    );
    expect(unboundedRead).not.toHaveBeenCalled();
    expect(
      read.mock.results.reduce(
        (total, result) => total + Number(result.value),
        0
      )
    ).toBeLessThanOrEqual(65_537);
    expect(close).toHaveBeenCalled();
  });

  it('accepts exactly the maximum capability-file size', () => {
    const root = rootWith();
    const required = `${REQUIRED.join('\n')}\n`;
    fs.writeFileSync(
      path.join(root, '.crm-audit.env'),
      `${required}#${'x'.repeat(65_536 - required.length - 1)}`,
      { mode: 0o600 }
    );
    expect(loadDedicatedAuditEnvironment({ projectRoot: root })).toEqual({
      CRM_AUDIT_SUPABASE_URL: 'https://project.supabase.co',
      CRM_AUDIT_API_KEY: 'synthetic-anon',
      CRM_AUDIT_ACCESS_TOKEN: 'synthetic-auditor',
      CRM_AUDIT_ACCOUNT_ID: '123e4567-e89b-42d3-a456-426614174000',
      CRM_AUDIT_REFERENCE_KEY: REFERENCE_KEY,
    });
  });

  it('rejects an oversized capability file before parsing it', () => {
    const root = rootWith();
    fs.writeFileSync(path.join(root, '.crm-audit.env'), 'x'.repeat(65_537), {
      mode: 0o600,
    });
    expect(() => loadDedicatedAuditEnvironment({ projectRoot: root })).toThrow(
      /archivo de entorno/i
    );
  });
});
