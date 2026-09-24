import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { readScopedReferenceIds } from '../src/lib/audit/supabase-reader.mjs';
import { loadDedicatedAuditEnvironment } from '../src/lib/audit/local-runtime-config.mjs';
import {
  buildCrmReferenceUrl,
  findUniqueRawId,
  publicResolverResult,
  validateReferenceRequest,
  validateCrmOrigin,
} from '../src/lib/audit/reference-resolver.mjs';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

export function loadEnvironment({ projectRoot = PROJECT_ROOT } = {}) {
  return loadDedicatedAuditEnvironment({ projectRoot });
}

function loadRuntimeConfig() {
  const env = loadEnvironment();
  const baseUrl = env.CRM_AUDIT_SUPABASE_URL;
  const apiKey = env.CRM_AUDIT_API_KEY;
  const accessToken = env.CRM_AUDIT_ACCESS_TOKEN;
  const referenceKey = env.CRM_AUDIT_REFERENCE_KEY;
  const uiOrigin = env.CRM_AUDIT_UI_ORIGIN;
  if (!baseUrl || !apiKey || !accessToken || !referenceKey || !uiOrigin) {
    throw new Error('Resolver configuration is incomplete.');
  }
  return {
    baseUrl,
    apiKey,
    accessToken,
    referenceKey,
    expectedOrigin: env.CRM_AUDIT_SUPABASE_ORIGIN ?? '',
    accountId: env.CRM_AUDIT_ACCOUNT_ID ?? '',
    uiOrigin,
  };
}

/** @param {string} url
 * @param {(command: string, args: string[], options: import('node:child_process').SpawnSyncOptions) => {status: number|null, error?: Error}} spawnImpl
 */
export function openWithSystem(url, spawnImpl = spawnSync) {
  const result = spawnImpl('/usr/bin/open', [url], {
    stdio: 'ignore',
    shell: false,
    env: {},
    timeout: 5_000,
    killSignal: 'SIGKILL',
  });
  if (result.error || result.status !== 0) {
    throw new Error('Unable to open CRM safely.');
  }
}

export async function runResolver({
  argv,
  loadConfig = loadRuntimeConfig,
  readIds = readScopedReferenceIds,
  openUrl = openWithSystem,
}) {
  if (!Array.isArray(argv) || argv.length !== 2) {
    throw new Error('Invalid CRM reference request.');
  }
  const request = validateReferenceRequest(argv[0], argv[1]);
  const config = loadConfig();
  const origin = validateCrmOrigin(config.uiOrigin);
  let timer;
  let rows;
  const controller = new AbortController();
  try {
    rows = await Promise.race([
      readIds({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        accessToken: config.accessToken,
        expectedOrigin: config.expectedOrigin,
        accountId: config.accountId,
        kind: request.kind,
        signal: controller.signal,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('CRM resolution timed out.'));
        }, 90_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  const rawId = findUniqueRawId(request.reference, rows, config.referenceKey);
  const url = buildCrmReferenceUrl(origin, request.kind, rawId);
  await openUrl(url);
  return publicResolverResult(request.kind, request.reference);
}

async function main() {
  const result = await runResolver({ argv: process.argv.slice(2) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch(() => {
    process.stderr.write(
      '[crm-audit-resolver] No se pudo abrir la referencia de forma segura.\n'
    );
    process.exitCode = 1;
  });
}
