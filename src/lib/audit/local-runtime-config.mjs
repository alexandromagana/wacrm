import fs from 'node:fs';
import path from 'node:path';

import { parseDotEnv } from './supabase-reader.mjs';
import { decodeReferenceKey } from './reference-key.mjs';

const MAX_ENV_FILE_BYTES = 65_536;
const DEDICATED_AUDIT_ENV_KEYS = Object.freeze(
  new Set([
    'CRM_AUDIT_SUPABASE_URL',
    'CRM_AUDIT_API_KEY',
    'CRM_AUDIT_ACCESS_TOKEN',
    'CRM_AUDIT_ACCOUNT_ID',
    'CRM_AUDIT_REFERENCE_KEY',
    'CRM_AUDIT_SUPABASE_ORIGIN',
    'CRM_AUDIT_UI_ORIGIN',
    'CRM_AUDIT_HISTORY_DAYS',
    'CRM_AUDIT_RESPONSE_SLA_MINUTES',
    'CRM_AUDIT_STALE_SENT_MINUTES',
    'CRM_AUDIT_PENDING_GRACE_MINUTES',
    'CRM_AUDIT_INCIDENT_LOOKBACK_DAYS',
  ])
);
const REQUIRED_DEDICATED_AUDIT_ENV_KEYS = Object.freeze([
  'CRM_AUDIT_SUPABASE_URL',
  'CRM_AUDIT_API_KEY',
  'CRM_AUDIT_ACCESS_TOKEN',
  'CRM_AUDIT_ACCOUNT_ID',
  'CRM_AUDIT_REFERENCE_KEY',
]);

function readAnchoredRegularFile(filePath, { privateFile = false } = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }
    throw new Error('El archivo de entorno del auditor no es confiable.');
  }

  try {
    const fileStat = fs.fstatSync(descriptor);
    if (
      !fileStat.isFile() ||
      fileStat.size > MAX_ENV_FILE_BYTES ||
      (typeof process.getuid === 'function' &&
        Number(fileStat.uid) !== process.getuid()) ||
      (fileStat.mode & (privateFile ? 0o077 : 0o022)) !== 0
    ) {
      throw new Error('El archivo de entorno del auditor no es confiable.');
    }
    // Never use readFileSync after a size check: the opened file can grow.
    // One extra byte distinguishes the exact limit from an oversized file.
    const buffer = Buffer.alloc(MAX_ENV_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_ENV_FILE_BYTES) {
      throw new Error('El archivo de entorno del auditor no es confiable.');
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    throw new Error('El archivo de entorno del auditor no es confiable.');
  } finally {
    fs.closeSync(descriptor);
  }
}

const OBSOLETE_OUTPUT_CAP_KEYS = new Set([
  'CRM_AUDIT_AWAITING_CONVERSATIONS',
  'CRM_AUDIT_RECENT_CONVERSATIONS',
  'CRM_AUDIT_MESSAGES_PER_CONVERSATION',
  'CRM_AUDIT_TECHNICAL_INCIDENTS',
]);

function rejectOutputCapOverrides(config) {
  if (Object.keys(config).some((key) => OBSOLETE_OUTPUT_CAP_KEYS.has(key))) {
    throw new Error('Los límites de salida del auditor son fijos.');
  }
}

const UNSAFE_RUNTIME_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_USE_ENV_PROXY',
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
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
]);

function rejectUnsafeRuntimeEnvironment() {
  // Presence (including an empty value) is rejected. This cannot undo runtime
  // hooks already consumed by Node: manual callers must start with env -i.
  for (const name of Object.keys(process.env)) {
    const key = name.toUpperCase();
    if (
      UNSAFE_RUNTIME_KEYS.has(key) ||
      key.startsWith('DYLD_') ||
      /^(?:HTTP|HTTPS|ALL|NO|FTP)_PROXY$/.test(key)
    ) {
      throw new Error('Entorno de ejecución no confiable; inicie con env -i.');
    }
  }
}

function resolveAnchoredRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new Error('La raíz del auditor no es válida.');
  }
  let anchoredRoot;
  try {
    anchoredRoot = fs.realpathSync.native(projectRoot);
  } catch {
    throw new Error('La raíz del auditor no es válida.');
  }
  if (anchoredRoot !== path.resolve(projectRoot)) {
    throw new Error('La raíz del auditor no es válida.');
  }
  return anchoredRoot;
}

export function loadDedicatedAuditEnvironment({ projectRoot } = {}) {
  rejectUnsafeRuntimeEnvironment();
  rejectOutputCapOverrides(process.env);
  const anchoredRoot = resolveAnchoredRoot(projectRoot);
  const text = readAnchoredRegularFile(
    path.join(anchoredRoot, '.crm-audit.env'),
    { privateFile: true }
  );
  if (text === null) {
    throw new Error('Falta el archivo dedicado de configuración del auditor.');
  }

  const environment = {};
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseDotEnv(line);
    rejectOutputCapOverrides(parsed);
    for (const [key, value] of Object.entries(parsed)) {
      if (!DEDICATED_AUDIT_ENV_KEYS.has(key)) {
        throw new Error('La configuración contiene una clave no permitida.');
      }
      if (Object.hasOwn(environment, key)) {
        throw new Error('Configuración del auditor duplicada.');
      }
      environment[key] = value;
    }
  }
  if (
    REQUIRED_DEDICATED_AUDIT_ENV_KEYS.some(
      (key) =>
        !Object.hasOwn(environment, key) || environment[key].trim() === ''
    )
  ) {
    throw new Error('La configuración dedicada del auditor está incompleta.');
  }
  decodeReferenceKey(environment.CRM_AUDIT_REFERENCE_KEY);
  return environment;
}
