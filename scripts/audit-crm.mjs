#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildAuditSnapshot } from '../src/lib/audit/crm-auditor.mjs';
import { parseAuditOptions } from '../src/lib/audit/audit-runtime-options.mjs';
import {
  classifyCollectorFailure,
  collectorFailureExitCode,
} from '../src/lib/audit/collector-failure.mjs';
import { loadDedicatedAuditEnvironment } from '../src/lib/audit/local-runtime-config.mjs';
import { readAuditData } from '../src/lib/audit/supabase-reader.mjs';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

export function loadEnvironment({ root = projectRoot } = {}) {
  return loadDedicatedAuditEnvironment({ projectRoot: root });
}

export async function collectAuditSnapshot({
  config,
  readData = readAuditData,
  clock = Date.now,
}) {
  const baseUrl = config.CRM_AUDIT_SUPABASE_URL;
  const apiKey = config.CRM_AUDIT_API_KEY;
  const accessToken = config.CRM_AUDIT_ACCESS_TOKEN;
  const referenceKey = config.CRM_AUDIT_REFERENCE_KEY;

  // The reads are bounded by the moment they start, but conversations are
  // not: a message that arrives while the pages download moves
  // last_message_at past that moment. "Future" is judged against the moment
  // the last page arrived, so only a clock that is really ahead still fails.
  const readStartedMs = clock();
  const { historyDays, ...snapshotOptions } = parseAuditOptions(config);
  const data = await readData({
    baseUrl,
    apiKey,
    accessToken,
    accountId: config.CRM_AUDIT_ACCOUNT_ID || '',
    expectedOrigin: config.CRM_AUDIT_SUPABASE_ORIGIN || '',
    nowMs: readStartedMs,
    historyDays,
    incidentLookbackDays: snapshotOptions.incidentLookbackDays,
  });
  const snapshot = buildAuditSnapshot(data, {
    nowMs: clock(),
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
  return output;
}

async function main() {
  const output = await collectAuditSnapshot({ config: loadEnvironment() });
  process.stdout.write(`${output}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    // Only the closed category leaves the process, never the error text.
    const category = classifyCollectorFailure(error);
    process.stderr.write(
      `[crm-auditor] La lectura falló (${category}); no se emitió un snapshot parcial.\n`
    );
    process.exitCode = collectorFailureExitCode(category);
  });
}
