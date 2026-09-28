const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_KEY_HEADER = ['api', 'key'].join('');
const AUTHORIZATION_HEADER = ['Author', 'ization'].join('');

const AUDIT_QUERIES = Object.freeze({
  contacts: {
    table: 'crm_audit_contacts',
    select: 'id,account_id',
    responseKeys: ['id', 'account_id'],
  },
  conversations: {
    table: 'crm_audit_conversations',
    select:
      'id,account_id,status,assigned_agent_id,ai_autoreply_disabled,ai_handoff_summary,last_message_at',
    responseKeys: [
      'id',
      'account_id',
      'status',
      'assigned_agent_id',
      'ai_autoreply_disabled',
      'ai_handoff_summary',
      'last_message_at',
    ],
  },
  messages: {
    table: 'crm_audit_messages',
    select:
      'id,conversation_id,sender_type,content_type,content_text,status,status_error,created_at,ai_generated,account_id',
    responseKeys: [
      'id',
      'conversation_id',
      'sender_type',
      'content_type',
      'content_text',
      'status',
      'status_error',
      'created_at',
      'ai_generated',
      'account_id',
    ],
  },

  automationLogs: {
    table: 'crm_audit_automation_logs',
    select:
      'id,account_id,automation_id,status,error_message,steps_executed,created_at',
    responseKeys: [
      'id',
      'account_id',
      'automation_id',
      'status',
      'error_message',
      'steps_executed',
      'created_at',
    ],
  },
  pendingExecutions: {
    table: 'crm_audit_pending_executions',
    select: 'id,account_id,automation_id,status,run_at,created_at',
    responseKeys: [
      'id',
      'account_id',
      'automation_id',
      'status',
      'run_at',
      'created_at',
    ],
  },
  flows: {
    table: 'crm_audit_flows',
    select: 'id,account_id,fallback_policy',
    responseKeys: ['id', 'account_id', 'fallback_policy'],
  },
  flowRuns: {
    table: 'crm_audit_flow_runs',
    select:
      'id,account_id,flow_id,conversation_id,status,last_advanced_at,end_reason',
    responseKeys: [
      'id',
      'account_id',
      'flow_id',
      'conversation_id',
      'status',
      'last_advanced_at',
      'end_reason',
    ],
  },
  webhookEndpoints: {
    table: 'crm_audit_webhook_endpoints',
    select: 'id,account_id,is_active,failure_count,last_delivery_at',
    responseKeys: [
      'id',
      'account_id',
      'is_active',
      'failure_count',
      'last_delivery_at',
    ],
  },
  whatsappConfigs: {
    table: 'crm_audit_whatsapp_config',
    select: 'id,account_id,status,last_registration_error',
    responseKeys: ['id', 'account_id', 'status', 'last_registration_error'],
  },
});

const REFERENCE_QUERIES = Object.freeze({
  conversation: Object.freeze({
    table: 'crm_audit_conversations',
    select: 'id,account_id',
    responseKeys: ['id', 'account_id'],
  }),
  automation: Object.freeze({
    table: 'crm_audit_automations',
    select: 'id,account_id',
    responseKeys: ['id', 'account_id'],
  }),
  flow: Object.freeze({
    table: 'crm_audit_flows',
    select: 'id,account_id',
    responseKeys: ['id', 'account_id'],
  }),
});

const ACCOUNT_QUERY = Object.freeze({
  table: 'crm_audit_accounts',
  select: 'id',
  responseKeys: ['id'],
});
const KNOWN_QUERY_DESCRIPTORS = new Set([
  ACCOUNT_QUERY,
  ...Object.values(AUDIT_QUERIES),
  ...Object.values(REFERENCE_QUERIES),
]);
const RESERVED_QUERY_KEYS = new Set(['select', 'order', 'limit', 'offset']);

export function parseDotEnv(content) {
  const values = {};
  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const equalsAt = line.indexOf('=');
    if (equalsAt < 1) continue;
    const key = line.slice(0, equalsAt).trim();
    let value = line.slice(equalsAt + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[key] = value;
  }
  return values;
}

function parseJsonWithoutDuplicateMembers(text) {
  if (typeof text !== 'string') throw new SyntaxError('Invalid JSON input.');

  const stack = [];
  let rootState = 'value';
  let index = 0;
  let nodes = 0;

  const skipWhitespace = () => {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[index])) {
      index += 1;
    }
  };
  const readString = () => {
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (code < 0x20) throw new SyntaxError('Invalid JSON string.');
      if (code !== 0x5c) {
        index += 1;
        continue;
      }
      index += 1;
      const escape = text[index];
      if (escape === 'u') {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) {
          throw new SyntaxError('Invalid JSON escape.');
        }
        index += 5;
      } else if ('"\\/bfnrt'.includes(escape ?? '')) {
        index += 1;
      } else {
        throw new SyntaxError('Invalid JSON escape.');
      }
    }
    throw new SyntaxError('Unterminated JSON string.');
  };
  const beginValue = () => {
    skipWhitespace();
    nodes += 1;
    if (nodes > 1_000_000) throw new SyntaxError('JSON input is too complex.');
    if (stack.length > 0) stack.at(-1).state = 'commaOrEnd';
    else rootState = 'done';

    const token = text[index];
    if (token === '{') {
      index += 1;
      stack.push({ type: 'object', state: 'keyOrEnd', keys: new Set() });
    } else if (token === '[') {
      index += 1;
      stack.push({ type: 'array', state: 'valueOrEnd' });
    } else if (token === '"') {
      readString();
    } else if (text.startsWith('true', index)) {
      index += 4;
    } else if (text.startsWith('false', index)) {
      index += 5;
    } else if (text.startsWith('null', index)) {
      index += 4;
    } else {
      const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!number) throw new SyntaxError('Invalid JSON value.');
      index += number[0].length;
    }
    if (stack.length > 64) throw new SyntaxError('JSON nesting is too deep.');
  };

  while (true) {
    skipWhitespace();
    if (stack.length === 0) {
      if (rootState === 'value') {
        beginValue();
        continue;
      }
      if (index !== text.length) throw new SyntaxError('Trailing JSON data.');
      return JSON.parse(text);
    }

    const context = stack.at(-1);
    const token = text[index];
    if (context.type === 'object') {
      if (context.state === 'keyOrEnd' && token === '}') {
        index += 1;
        stack.pop();
      } else if (context.state === 'keyOrEnd' || context.state === 'key') {
        if (token !== '"') throw new SyntaxError('Invalid JSON object key.');
        const key = readString();
        if (context.keys.has(key)) throw new SyntaxError('Duplicate JSON member.');
        context.keys.add(key);
        context.state = 'colon';
      } else if (context.state === 'colon') {
        if (token !== ':') throw new SyntaxError('Missing JSON colon.');
        index += 1;
        context.state = 'value';
      } else if (context.state === 'value') {
        beginValue();
      } else if (token === ',') {
        index += 1;
        context.state = 'key';
      } else if (token === '}') {
        index += 1;
        stack.pop();
      } else {
        throw new SyntaxError('Invalid JSON object delimiter.');
      }
    } else if (
      (context.state === 'valueOrEnd' || context.state === 'value') &&
      token !== ']'
    ) {
      beginValue();
    } else if (context.state === 'valueOrEnd' && token === ']') {
      index += 1;
      stack.pop();
    } else if (context.state === 'commaOrEnd' && token === ',') {
      index += 1;
      context.state = 'value';
    } else if (context.state === 'commaOrEnd' && token === ']') {
      index += 1;
      stack.pop();
    } else {
      throw new SyntaxError('Invalid JSON array delimiter.');
    }
  }
}

function responsePaginationState(response, batchLength) {
  const contentRange = response.headers.get('content-range');
  if (!contentRange) {
    throw new Error(
      'Supabase no devolvió Content-Range; cobertura de paginación desconocida.'
    );
  }

  if (contentRange === '*/0' && batchLength === 0) {
    return { hasMore: false, confirmedRemaining: 0, total: 0 };
  }
  const match = contentRange.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (!match) {
    throw new Error(
      'Supabase devolvió un Content-Range inválido; cobertura desconocida.'
    );
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start !== 0 ||
    end < start ||
    end !== batchLength - 1 ||
    end - start + 1 !== batchLength ||
    total < batchLength ||
    end >= total
  ) {
    throw new Error(
      'Supabase devolvió un Content-Range inconsistente; cobertura desconocida.'
    );
  }
  const confirmedRemaining = total - batchLength;
  return {
    hasMore: confirmedRemaining > 0,
    confirmedRemaining,
    total,
  };
}

function parsePinnedJwt(value, requiredClaims, message) {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 4096 ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new Error(message);
  }
  try {
    const parts = value.split('.');
    if (
      parts.length !== 3 ||
      parts.some(
        (part) => !part || part.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(part)
      )
    )
      throw new Error();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const headerBytes = Buffer.from(parts[0], 'base64url');
    const payloadBytes = Buffer.from(parts[1], 'base64url');
    if (
      headerBytes.toString('base64url') !== parts[0] ||
      payloadBytes.toString('base64url') !== parts[1]
    ) {
      throw new Error();
    }
    const headerJson = decoder.decode(headerBytes);
    const payloadJson = decoder.decode(payloadBytes);
    if (headerJson.includes('\\u') || payloadJson.includes('\\u')) {
      throw new Error('escaped JWT claim');
    }
    const header = parseJsonWithoutDuplicateMembers(headerJson);
    const payload = parseJsonWithoutDuplicateMembers(payloadJson);
    const claimCount = (text, name) =>
      (text.match(new RegExp(`"${name}"\\s*:`, 'g')) ?? []).length;
    const hasRequiredClaims = requiredClaims.every(
      (name) => claimCount(payloadJson, name) === 1
    );
    if (
      !header ||
      typeof header !== 'object' ||
      Array.isArray(header) ||
      Object.getPrototypeOf(header) !== Object.prototype ||
      claimCount(headerJson, 'alg') !== 1 ||
      header.alg !== 'HS256' ||
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      Object.getPrototypeOf(payload) !== Object.prototype ||
      !hasRequiredClaims
    ) {
      throw new Error();
    }
    return payload;
  } catch {
    throw new Error(message);
  }
}

function validateProjectRef(value, message) {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
  ) {
    throw new Error(message);
  }
  return value;
}

export function validateSupabaseCredentials({
  baseUrl,
  apiKey,
  accessToken,
  accountId,
  expectedOrigin = '',
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const credentialError =
    'Las credenciales de Supabase no pertenecen al principal de auditoría.';
  if (
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 0 ||
    typeof accountId !== 'string' ||
    !UUID.test(accountId) ||
    accountId !== accountId.toLowerCase()
  ) {
    throw new Error('La cuenta o vigencia de la credencial es inválida.');
  }
  const apiClaims = parsePinnedJwt(
    apiKey,
    ['role', 'ref', 'exp'],
    credentialError
  );
  const auditClaims = parsePinnedJwt(
    accessToken,
    ['role', 'ref', 'account_id', 'exp'],
    credentialError
  );
  const projectRef = validateProjectRef(apiClaims.ref, credentialError);
  if (
    apiClaims.role !== 'anon' ||
    !Number.isSafeInteger(apiClaims.exp) ||
    apiClaims.exp <= nowSeconds ||
    auditClaims.role !== 'gama_crm_auditor' ||
    validateProjectRef(auditClaims.ref, credentialError) !== projectRef ||
    auditClaims.account_id !== accountId ||
    !Number.isSafeInteger(auditClaims.exp) ||
    auditClaims.exp <= nowSeconds
  ) {
    throw new Error(credentialError);
  }
  let requested;
  try {
    requested = new URL(baseUrl);
  } catch {
    throw new Error('El origen de Supabase no es una URL válida.');
  }
  if (requested.protocol !== 'https:') {
    throw new Error(
      'El auditor sólo envía credenciales de Supabase por HTTPS.'
    );
  }
  if (
    requested.username ||
    requested.password ||
    requested.pathname !== '/' ||
    requested.search ||
    requested.hash
  ) {
    throw new Error('El origen de Supabase debe ser un origen HTTPS exacto.');
  }

  const jwtOrigin = `https://${projectRef}.supabase.co`;

  let pinned;
  try {
    pinned = new URL(jwtOrigin);
  } catch {
    throw new Error('CRM_AUDIT_SUPABASE_ORIGIN no es una URL válida.');
  }
  if (jwtOrigin && expectedOrigin) {
    let configured;
    try {
      configured = new URL(expectedOrigin);
    } catch {
      throw new Error('CRM_AUDIT_SUPABASE_ORIGIN no es una URL válida.');
    }
    if (
      configured.protocol !== 'https:' ||
      configured.origin !== jwtOrigin ||
      configured.username ||
      configured.password ||
      configured.pathname !== '/' ||
      configured.search ||
      configured.hash
    ) {
      throw new Error(
        'El origen configurado no coincide con las credenciales.'
      );
    }
  }
  if (pinned.protocol !== 'https:' || requested.origin !== pinned.origin) {
    throw new Error('El origen de Supabase no coincide con el origen fijado.');
  }
  return { origin: requested.origin, accountId };
}

function validateReadLimits({
  pageSize,
  maxRows,
  requestTimeoutMs,
  totalTimeoutMs,
  maxResponseBytes,
  maxPages,
}) {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 1000 ||
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > 20_000 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 100 ||
    requestTimeoutMs > 60_000 ||
    !Number.isSafeInteger(totalTimeoutMs) ||
    totalTimeoutMs < requestTimeoutMs ||
    totalTimeoutMs > 300_000 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 256 ||
    maxResponseBytes > 5_000_000 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 100
  ) {
    throw new Error('Los límites de lectura de Supabase son inválidos.');
  }
}

function normaliseReadLimits(value) {
  const defaults = {
    pageSize: 1000,
    maxRows: 20_000,
    requestTimeoutMs: 15_000,
    totalTimeoutMs: 60_000,
    maxResponseBytes: 2_000_000,
    maxPages: 25,
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Los límites de lectura de Supabase son inválidos.');
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(defaults, key)) {
      throw new Error('Los límites de lectura de Supabase son inválidos.');
    }
  }
  const limits = { ...defaults, ...value };
  validateReadLimits(limits);
  return limits;
}

async function readBoundedJson(
  response,
  table,
  maxResponseBytes,
  signal,
  operation,
  queryBudget
) {
  const declaredLength = response.headers.get('content-length');
  if (
    typeof declaredLength === 'string' &&
    /^\d+$/.test(declaredLength) &&
    (declaredLength.length > 20 ||
      BigInt(declaredLength) > BigInt(maxResponseBytes))
  ) {
    throw new Error(`Supabase excedió el límite de respuesta (${table}).`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error(`Supabase returned an unreadable body (${table}).`);
  }
  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancelReader, { once: true });
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      operation.bytes += value.byteLength;
      queryBudget.bytes += value.byteLength;
      if (
        operation.bytes > 64 * 1024 * 1024 ||
        queryBudget.bytes > 32 * 1024 * 1024
      ) {
        void reader.cancel().catch(() => {});
        throw new Error(`Supabase excedió el presupuesto de bytes (${table}).`);
      }
      if (totalBytes > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Supabase excedió el límite de respuesta (${table}).`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
  }

  try {
    signal.throwIfAborted();
    return parseJsonWithoutDuplicateMembers(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, totalBytes)
      )
    );
  } catch {
    throw new Error(`Supabase returned invalid JSON (${table}).`);
  }
}

function exactObjectKeys(row, expectedKeys, label) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`Supabase devolvió un esquema inválido (${label}).`);
  }
  const actual = Object.keys(row).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`Supabase devolvió un esquema inválido (${label}).`);
  }
}

function validateAndStripRows(descriptor, rows, accountId) {
  return rows.map((row) => {
    exactObjectKeys(row, descriptor.responseKeys, descriptor.table);
    if (typeof row.id !== 'string' || !UUID.test(row.id)) {
      throw new Error(
        `Supabase devolvió un esquema inválido (${descriptor.table}).`
      );
    }

    const returnedAccountId = row.account_id;
    if (
      typeof returnedAccountId !== 'string' ||
      !UUID.test(returnedAccountId) ||
      returnedAccountId.toLowerCase() !== accountId.toLowerCase()
    ) {
      throw new Error(
        `Supabase devolvió una cuenta distinta o inválida (${descriptor.table}).`
      );
    }

    return Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== 'account_id')
    );
  });
}

async function fetchDescriptorRows({
  baseUrl,
  apiKey,
  accessToken,
  accountId,
  descriptor,
  filters = {},
  pageSize = 1000,
  maxRows = 20_000,
  requestTimeoutMs = 15_000,
  totalTimeoutMs = 60_000,
  maxResponseBytes = 2_000_000,
  maxPages = 25,
  expectedOrigin = '',
  fetchImpl = fetch,
  operation,
}) {
  validateReadLimits({
    pageSize,
    maxRows,
    requestTimeoutMs,
    totalTimeoutMs,
    maxResponseBytes,
    maxPages,
  });
  if (!KNOWN_QUERY_DESCRIPTORS.has(descriptor)) {
    throw new Error('La consulta no pertenece al allowlist fijo del auditor.');
  }
  const { origin: trustedBaseUrl } = validateSupabaseCredentials({
    baseUrl,
    apiKey,
    accessToken,
    accountId,
    expectedOrigin,
  });
  const { table, select } = descriptor;
  const baseQueryUrl = new URL(`/rest/v1/${table}`, `${trustedBaseUrl}/`);
  baseQueryUrl.searchParams.set('select', select);
  baseQueryUrl.searchParams.set('order', 'id.asc');
  baseQueryUrl.searchParams.set('limit', String(pageSize));
  for (const [key, value] of Object.entries(filters)) {
    if (
      RESERVED_QUERY_KEYS.has(key) ||
      baseQueryUrl.searchParams.has(key) ||
      typeof value !== 'string' ||
      value.length > 2048
    ) {
      throw new Error('La consulta contiene filtros inseguros.');
    }
    baseQueryUrl.searchParams.append(key, value);
  }

  const rows = [];
  const queryBudget = { bytes: 0 };
  let cursor = null;
  let expectedPageTotal = null;
  let pages = 0;
  const deadline = Date.now() + totalTimeoutMs;
  while (true) {
    operation.controller.signal.throwIfAborted();
    pages += 1;
    if (pages > maxPages || Date.now() >= deadline) {
      throw new Error(`Supabase excedió el límite de cobertura (${table}).`);
    }
    const pageUrl = new URL(baseQueryUrl);
    if (cursor !== null) pageUrl.searchParams.append('id', `gt.${cursor}`);
    const controller = new AbortController();
    operation.controllers.add(controller);
    const remainingMs = Math.max(1, deadline - Date.now());
    const timeoutMs = Math.min(requestTimeoutMs, remainingMs);
    let rejectTimeout;
    const timedOut = new Promise((_, reject) => {
      rejectTimeout = reject;
    });
    const abortFromOperation = () => {
      controller.abort();
      rejectTimeout(new Error('Supabase request aborted.'));
    };
    operation.controller.signal.addEventListener('abort', abortFromOperation, {
      once: true,
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectTimeout(new Error('Supabase request timed out.'));
    }, timeoutMs);
    let response;
    let batch;
    try {
      response = await Promise.race([
        fetchImpl(pageUrl, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            [API_KEY_HEADER]: apiKey,
            [AUTHORIZATION_HEADER]: ['Bearer', accessToken].join(' '),
            Accept: 'application/json',
            'Accept-Profile': 'crm_audit_api',
            Prefer: 'count=exact',
          },
        }),
        timedOut,
      ]);
      if (!response.ok) {
        throw new Error(`Supabase read failed (HTTP ${response.status}).`);
      }
      batch = await Promise.race([
        readBoundedJson(
          response,
          table,
          maxResponseBytes,
          controller.signal,
          operation,
          queryBudget
        ),
        timedOut,
      ]);
    } catch (error) {
      // Keep only which side failed, never the original error: it can carry
      // response text. No response, or our own timeout, means Supabase was
      // never reached in time.
      const failure = new Error(
        `Supabase request failed for allowlisted table "${table}".`
      );
      failure.category =
        response === undefined ||
        (error instanceof Error && error.message === 'Supabase request timed out.')
          ? 'red'
          : 'respuesta';
      throw failure;
    } finally {
      clearTimeout(timeout);
      operation.controller.signal.removeEventListener(
        'abort',
        abortFromOperation
      );
    }
    if (!Array.isArray(batch)) {
      throw new Error(
        `Supabase returned a non-array for allowlisted table "${table}"`
      );
    }
    const pagination = responsePaginationState(response, batch.length);
    if (expectedPageTotal !== null && pagination.total !== expectedPageTotal) {
      throw new Error(
        `Supabase devolvió un Content-Range contradictorio para "${table}"; cobertura desconocida.`
      );
    }
    expectedPageTotal = pagination.confirmedRemaining;
    let priorId = cursor;
    for (const row of batch) {
      if (
        !row ||
        typeof row !== 'object' ||
        typeof row.id !== 'string' ||
        (priorId !== null && row.id <= priorId)
      ) {
        throw new Error(
          `Supabase devolvió un cursor inválido para "${table}".`
        );
      }
      priorId = row.id;
    }
    if (rows.length + batch.length > maxRows) {
      throw new Error(
        `Supabase excedió el límite seguro de filas para "${table}".`
      );
    }
    rows.push(...batch);
    if (!pagination.hasMore) break;
    const nextCursor = batch.at(-1)?.id;
    if (typeof nextCursor !== 'string' || nextCursor === cursor) {
      throw new Error(
        `Supabase no pudo paginar de forma segura la tabla "${table}".`
      );
    }
    cursor = nextCursor;
  }
  return rows;
}

async function resolveSingleAccountId({
  baseUrl,
  apiKey,
  accessToken,
  accountId,
  expectedOrigin,
  fetchImpl,
  operation,
  limits,
}) {
  if (typeof accountId !== 'string' || !UUID.test(accountId)) {
    throw new Error(
      'Define CRM_AUDIT_ACCOUNT_ID como UUID para limitar la auditoría a una sola cuenta.'
    );
  }

  const accountRows = await fetchDescriptorRows({
    ...limits,
    operation,
    baseUrl,
    apiKey,
    accessToken,
    accountId,
    descriptor: ACCOUNT_QUERY,
    filters: { id: `eq.${accountId}` },
    pageSize: 2,
    maxRows: 2,
    expectedOrigin,
    fetchImpl,
  });
  if (accountRows.length !== 1) {
    throw new Error(
      'Supabase no confirmó exactamente la cuenta configurada; cobertura desconocida.'
    );
  }
  exactObjectKeys(accountRows[0], ACCOUNT_QUERY.responseKeys, 'accounts');
  const resolvedAccountId = accountRows[0]?.id;
  if (
    typeof resolvedAccountId !== 'string' ||
    !UUID.test(resolvedAccountId) ||
    resolvedAccountId.toLowerCase() !== accountId.toLowerCase()
  ) {
    throw new Error(
      'Supabase devolvió una cuenta distinta o inválida; cobertura desconocida.'
    );
  }
  return resolvedAccountId;
}

async function readScopedReferenceIdsInner(
  {
    baseUrl,
    apiKey,
    accessToken,
    accountId = '',
    expectedOrigin = '',
    kind,
    readLimits = {},
    fetchImpl = fetch,
  },
  operation
) {
  const descriptor = REFERENCE_QUERIES[kind];
  if (!descriptor) {
    throw new Error('Unsupported CRM reference kind.');
  }

  const limits = normaliseReadLimits(readLimits);
  const resolvedAccountId = await resolveSingleAccountId({
    operation,
    limits,
    baseUrl,
    apiKey,
    accessToken,
    accountId,
    expectedOrigin,
    fetchImpl,
  });
  const rows = await fetchDescriptorRows({
    baseUrl,
    apiKey,
    accessToken,
    accountId: resolvedAccountId,
    descriptor,
    filters: { account_id: `eq.${resolvedAccountId}` },
    ...limits,
    operation,
    expectedOrigin,
    fetchImpl,
  });
  return validateAndStripRows(descriptor, rows, resolvedAccountId);
}

/**
 * Fetch the fixed, read-only dataset used by the auditor. There is no caller-
 * supplied table or filter. A dedicated PostgREST role can only SELECT the
 * account-bound security-barrier views used below.
 */
async function readAuditDataInner(
  {
    baseUrl,
    apiKey,
    accessToken,
    accountId = '',
    expectedOrigin = '',
    nowMs = Date.now(),
    historyDays = 90,
    incidentLookbackDays = 30,
    readLimits = {},
    fetchImpl = fetch,
  },
  operation
) {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(historyDays) ||
    historyDays < 1 ||
    historyDays > 365 ||
    !Number.isSafeInteger(incidentLookbackDays) ||
    incidentLookbackDays < 1 ||
    incidentLookbackDays > 365
  ) {
    throw new Error('La ventana temporal de lectura es inválida.');
  }
  const effectiveHistoryDays = Math.max(historyDays, incidentLookbackDays);
  const cutoff = new Date(nowMs).toISOString();
  const historyStart = new Date(
    nowMs - effectiveHistoryDays * 86_400_000
  ).toISOString();
  const limits = normaliseReadLimits(readLimits);
  const resolvedAccountId = await resolveSingleAccountId({
    operation,
    limits,
    baseUrl,
    apiKey,
    accessToken,
    accountId,
    expectedOrigin,
    fetchImpl,
  });

  const scopedFilters = (key) => {
    const filters = {
      account_id: `eq.${resolvedAccountId}`,
    };
    if (key === 'messages' || key === 'automationLogs') {
      filters.and = `(created_at.gte.${historyStart},created_at.lte.${cutoff})`;
    }
    if (key === 'pendingExecutions') {
      filters.status = 'eq.pending';
      filters.run_at = `lte.${cutoff}`;
    }
    if (key === 'flowRuns') {
      filters.or = `(status.eq.active,and(status.eq.failed,last_advanced_at.gte.${historyStart},last_advanced_at.lte.${cutoff}))`;
    }
    return filters;
  };

  const entries = await Promise.all(
    Object.entries(AUDIT_QUERIES).map(async ([key, query]) => [
      key,
      validateAndStripRows(
        query,
        await fetchDescriptorRows({
          baseUrl,
          apiKey,
          accessToken,
          accountId: resolvedAccountId,
          descriptor: query,
          filters: scopedFilters(key),
          ...limits,
          operation,
          expectedOrigin,
          fetchImpl,
        }),
        resolvedAccountId
      ),
    ])
  );
  return Object.fromEntries(entries);
}

const COMMON_OPTION_KEYS = Object.freeze([
  'baseUrl',
  'apiKey',
  'accessToken',
  'accountId',
  'expectedOrigin',
  'fetchImpl',
  'readLimits',
  'signal',
]);

async function withReadOperation(options, allowedKeys, reader) {
  if (
    !options ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Object.keys(options).some((key) => !allowedKeys.includes(key))
  ) {
    throw new Error('Invalid read options');
  }
  const externalSignal = options.signal;
  if (
    externalSignal !== undefined &&
    !(externalSignal instanceof AbortSignal)
  ) {
    throw new Error('Invalid read options');
  }
  if (externalSignal?.aborted) {
    throw new Error('Supabase read aborted.');
  }
  const limits = normaliseReadLimits(
    options.readLimits === undefined ? {} : options.readLimits
  );
  const operation = {
    controller: new AbortController(),
    controllers: new Set(),
    bytes: 0,
  };
  const abortFromExternalSignal = () => operation.controller.abort();
  externalSignal?.addEventListener('abort', abortFromExternalSignal, {
    once: true,
  });
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      operation.controller.abort();
      reject(new Error('Supabase request failed: total deadline exceeded'));
    }, limits.totalTimeoutMs);
  });
  try {
    return await Promise.race([reader(options, operation), deadline]);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    operation.controller.abort();
    for (const controller of operation.controllers) controller.abort();
  }
}

export async function readAuditData(options) {
  return withReadOperation(
    options,
    [...COMMON_OPTION_KEYS, 'nowMs', 'historyDays', 'incidentLookbackDays'],
    readAuditDataInner
  );
}

export async function readScopedReferenceIds(options) {
  return withReadOperation(
    options,
    [...COMMON_OPTION_KEYS, 'kind'],
    readScopedReferenceIdsInner
  );
}
