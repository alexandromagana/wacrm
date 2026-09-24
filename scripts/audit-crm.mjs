#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildAuditSnapshot } from '../src/lib/audit/crm-auditor.mjs';
import { parseAuditOptions } from '../src/lib/audit/audit-runtime-options.mjs';
import { loadDedicatedAuditEnvironment } from '../src/lib/audit/local-runtime-config.mjs';
import { readAuditData } from '../src/lib/audit/supabase-reader.mjs';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

export function loadEnvironment({ root = projectRoot } = {}) {
  return loadDedicatedAuditEnvironment({ projectRoot: root });
}

async function main() {
  const config = loadEnvironment();
  const baseUrl = config.CRM_AUDIT_SUPABASE_URL;
  const apiKey = config.CRM_AUDIT_API_KEY;
  const accessToken = config.CRM_AUDIT_ACCESS_TOKEN;
  const referenceKey = config.CRM_AUDIT_REFERENCE_KEY;

  const nowMs = Date.now();
  const { historyDays, ...snapshotOptions } = parseAuditOptions(config);
  const data = await readAuditData({
    baseUrl,
    apiKey,
    accessToken,
    accountId: config.CRM_AUDIT_ACCOUNT_ID || '',
    expectedOrigin: config.CRM_AUDIT_SUPABASE_ORIGIN || '',
    nowMs,
    historyDays,
    incidentLookbackDays: snapshotOptions.incidentLookbackDays,
  });
  const snapshot = buildAuditSnapshot(data, {
    nowMs,
    ...snapshotOptions,
    referenceKey,
  });

  const output = JSON.stringify(snapshot);
  if (
    [apiKey, accessToken, referenceKey].some((secret) =>
      output.includes(secret)
    )
  ) {
    throw new Error(
      'El snapshot coincidió con una credencial sensible y fue bloqueado.'
    );
  }
  process.stdout.write(`${output}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch(() => {
    process.stderr.write(
      '[crm-auditor] La lectura falló; no se emitió un snapshot parcial.\n'
    );
    process.exitCode = 1;
  });
}
