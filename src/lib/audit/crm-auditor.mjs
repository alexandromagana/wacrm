import { createHmac } from 'node:crypto';

import { decodeReferenceKey } from './reference-key.mjs';

const RESOLVING_OUTBOUND_STATUSES = new Set(['delivered', 'read']);
const OUTBOUND_SENDERS = new Set(['agent', 'bot']);
const CONVERSATION_STATUSES = new Set(['closed', 'open', 'pending']);
const MESSAGE_SENDERS = new Set(['agent', 'bot', 'customer']);
const MESSAGE_CONTENT_TYPES = new Set([
  'audio',
  'document',
  'image',
  'interactive',
  'location',
  'sticker',
  'template',
  'text',
  'video',
]);
const MESSAGE_STATUSES = new Set([
  'delivered',
  'failed',
  'read',
  'received',
  'sending',
  'sent',
]);
const WHATSAPP_STATUSES = new Set(['connected', 'disconnected', 'pending']);
const AUTOMATION_LOG_STATUSES = new Set(['failed', 'partial', 'success']);
const AUTOMATION_STEP_STATUSES = new Set(['failed', 'skipped', 'success']);
const FLOW_RUN_STATUSES = new Set(['active', 'failed']);
const MAX_TEMPORAL_MINUTES = 525_600;
const MAX_FLOW_TIMEOUT_HOURS = 8_760;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const NON_ACTIONABLE_CUSTOMER_SIGNALS = new Set([
  'closure',
  'do_not_contact',
  'empty',
]);
const CLOSURE_PHRASES = new Set([
  'ok',
  'okay',
  'gracias',
  'muchas gracias',
  'perfecto',
  'entendido',
  'vale',
  'listo',
  'todo listo',
  'lo checo',
  'lo reviso',
  'dejame revisarlo',
  'permiteme revisarlo',
  'te aviso',
  'estoy en contacto',
]);
const SOURCE_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|[+-](\d{2}):(\d{2}))$/;
const AUTOMATION_STEP_TYPES = new Set([
  'send_message',
  'send_buttons',
  'send_list',
  'send_template',
  'add_tag',
  'remove_tag',
  'assign_conversation',
  'update_contact_field',
  'create_deal',
  'move_deal',
  'wait',
  'condition',
  'send_webhook',
  'close_conversation',
]);

function asTime(value, nullable = false) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new Error(
      'El CRM devolvió una fecha inválida; cobertura desconocida.'
    );
  }
  const match = typeof value === 'string' ? SOURCE_TIMESTAMP.exec(value) : null;
  if (!match) {
    throw new Error(
      'El CRM devolvió una fecha inválida; cobertura desconocida.'
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    0,
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new Error(
      'El CRM devolvió una fecha inválida; cobertura desconocida.'
    );
  }

  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new Error(
      'El CRM devolvió una fecha inválida; cobertura desconocida.'
    );
  }
  const utcYear = new Date(time).getUTCFullYear();
  if (utcYear < 1 || utcYear > 9999) {
    throw new Error(
      'El CRM devolvió una fecha inválida; cobertura desconocida.'
    );
  }
  return time;
}

function canonicalTimestamp(value, nullable = false) {
  const time = asTime(value, nullable);
  return time === null ? null : new Date(time).toISOString();
}

// Keep all accepted fractional digits internally; wire timestamps stay in ms.
function asInstant(value, nullable = false) {
  const time = asTime(value, nullable);
  if (time === null) return null;
  const fraction = (SOURCE_TIMESTAMP.exec(value)[7] ?? '').padEnd(9, '0');
  return BigInt(time) * NANOSECONDS_PER_MILLISECOND + BigInt(fraction.slice(3));
}

function elapsedNanoseconds(value, nowMs, nullable = false) {
  const instant = asInstant(value, nullable);
  return instant === null
    ? null
    : BigInt(nowMs) * NANOSECONDS_PER_MILLISECOND - instant;
}

function elapsedAtLeast(value, nowMs, thresholdMs) {
  const elapsed = elapsedNanoseconds(value, nowMs);
  return (
    elapsed !== null &&
    elapsed >= BigInt(thresholdMs) * NANOSECONDS_PER_MILLISECOND
  );
}

function canonicalSnapshotTimes(value) {
  if (Array.isArray(value)) return value.map(canonicalSnapshotTimes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      ['at', 'last_message_at', 'latest_at', 'run_at'].includes(key)
        ? canonicalTimestamp(child)
        : canonicalSnapshotTimes(child),
    ])
  );
}

function assertNotFuture(value, nowMs, nullable = false) {
  const time = asInstant(value, nullable);
  if (time !== null && time > BigInt(nowMs) * 1_000_000n) {
    throw new Error(
      'El CRM devolvió un timestamp futuro; cobertura desconocida.'
    );
  }
  return time;
}

function compactWhitespace(value) {
  if (typeof value === 'string' && value.length > 65_536) {
    throw new Error(
      'El CRM excedió el límite de texto; cobertura desconocida.'
    );
  }
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shortRef(value, referenceKey) {
  const keyBytes = decodeReferenceKey(referenceKey);
  return createHmac('sha256', keyBytes)
    .update('gama-crm-audit-reference-v2\0')
    .update(String(value ?? ''), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function referenceFactory(referenceKey) {
  const rawByReference = new Map();
  return (value) => {
    const raw = String(value ?? '');
    const reference = shortRef(raw, referenceKey);
    const existing = rawByReference.get(reference);
    if (existing !== undefined && existing !== raw) {
      throw new Error('CRM reference collision; coverage unknown.');
    }
    rawByReference.set(reference, raw);
    return reference;
  };
}

function ageBucket(value, nowMs) {
  const elapsed = elapsedNanoseconds(value, nowMs);
  const age = elapsed !== null && elapsed > 0n ? elapsed : 0n;
  const minutes = (value) =>
    BigInt(value * 60_000) * NANOSECONDS_PER_MILLISECOND;
  if (age < minutes(30)) return '<30m';
  if (age < minutes(120)) return '30m-2h';
  if (age < minutes(1_440)) return '2h-24h';
  if (age < minutes(10_080)) return '1d-7d';
  return '7d+';
}

function severityForAge(bucket) {
  if (bucket === '<30m' || bucket === '30m-2h') return 'medium';
  return 'high';
}

const SOURCE_COLLECTIONS = [
  'contacts',
  'conversations',
  'messages',
  'automationLogs',
  'pendingExecutions',
  'flows',
  'flowRuns',
  'webhookEndpoints',
  'whatsappConfigs',
];

function validateSourceBounds(
  value,
  depth = 0,
  budget = { nodes: 0, bytes: 0 }
) {
  budget.nodes += 1;
  if (depth > 12 || budget.nodes > 2_000_000) {
    throw new Error(
      'El CRM excedió límites de entrada; cobertura desconocida.'
    );
  }
  if (typeof value === 'string') {
    if (value.length > 65_536) {
      throw new Error(
        'El CRM excedió límites de texto; cobertura desconocida.'
      );
    }
    budget.bytes += Buffer.byteLength(value, 'utf8');
    if (budget.bytes > 64 * 1024 * 1024) {
      throw new Error(
        'El CRM excedió límites de entrada; cobertura desconocida.'
      );
    }
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 20_000) {
      throw new Error(
        'El CRM excedió límites de entrada; cobertura desconocida.'
      );
    }
    for (const key of keys) {
      validateSourceBounds(key, depth + 1, budget);
      validateSourceBounds(value[key], depth + 1, budget);
    }
  }
}

function normaliseInput(rawData) {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    throw new Error(
      'El CRM devolvió colecciones inválidas; cobertura desconocida.'
    );
  }

  validateSourceBounds(rawData);
  for (const key of SOURCE_COLLECTIONS) {
    if (!Array.isArray(rawData[key])) {
      throw new Error(
        'El CRM devolvió colecciones inválidas; cobertura desconocida.'
      );
    }
  }

  return {
    contacts: rawData.contacts,
    conversations: rawData.conversations,
    messages: rawData.messages,
    automationLogs: rawData.automationLogs,
    pendingExecutions: rawData.pendingExecutions,
    flows: rawData.flows,
    flowRuns: rawData.flowRuns,
    webhookEndpoints: rawData.webhookEndpoints,
    whatsappConfigs: rawData.whatsappConfigs,
  };
}

function safeEnum(value, allowed) {
  return allowed.has(value) ? value : 'unknown';
}

function requireSourceState(condition) {
  if (!condition) {
    throw new Error(
      'El CRM devolvió un estado inválido; cobertura desconocida.'
    );
  }
}

function compareCodeUnits(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function requireIdentifier(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)
  ) {
    throw new Error(
      'El CRM devolvió identificadores inválidos; cobertura desconocida.'
    );
  }
  return value;
}

function requireUniqueIdentifiers(data) {
  for (const key of SOURCE_COLLECTIONS) {
    const seen = new Set();
    for (const row of data[key]) {
      const validRow = row && typeof row === 'object' && !Array.isArray(row);
      const id = validRow ? row.id : null;
      requireIdentifier(id);
      if (seen.has(id)) {
        throw new Error(
          'El CRM devolvió identificadores inválidos; cobertura desconocida.'
        );
      }
      seen.add(id);
    }
  }
}

function requireSourceRelationships(data) {
  const conversationIds = new Set(
    data.conversations.map((conversation) => conversation.id)
  );
  const flowIds = new Set(data.flows.map((flow) => flow.id));
  const invalid =
    data.messages.some(
      (message) =>
        !conversationIds.has(requireIdentifier(message.conversation_id))
    ) ||
    data.flowRuns.some(
      (run) =>
        !flowIds.has(requireIdentifier(run.flow_id)) ||
        (run.conversation_id !== null &&
          run.conversation_id !== undefined &&
          !conversationIds.has(requireIdentifier(run.conversation_id)))
    );

  if (invalid) {
    throw new Error(
      'El CRM devolvió relaciones inválidas; cobertura desconocida.'
    );
  }
}

function messageSignal(message) {
  if (message.content_type !== 'text') return 'media';
  const text = compactWhitespace(message.content_text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  if (!text) return 'empty';
  const frustration =
    /\b(?:molest[a-z]*|enoj[a-z]*|pesim[a-z]*|queja[a-z]*|reclamo[a-z]*|nadie responde|sin respuesta)\b/.test(
      text
    );
  const closureParts = text
    .split(/(?:[,;.!]+|\s+y\s+)/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (
    closureParts.length > 0 &&
    closureParts.every((part) => CLOSURE_PHRASES.has(part))
  ) {
    return 'closure';
  }
  if (
    /(?:\bno\s+(?:me\s+)?(?:contact(?:es|e|en|ar(?:me)?)|escrib(?:as|a|an|ir(?:me)?)|mand(?:es|e|en|ar(?:me)?)\s+mensajes?)\b|\bdejen?\s+de\s+(?:contact[a-z]*|escrib[a-z]*|mand[a-z]*\s+mensajes?)\b|\bno\s+quiero\s+que\s+(?:me\s+)?(?:contacten|escriban|manden\s+mensajes?)\b|\bno\s+quiero\s+ser\s+contactad[oa]\b|\bno\s+quiero\s+(?:recibir\s+)?(?:mas\s+)?mensajes?\b|\b(?:dame|darme|quiero\s+darme)\s+de\s+baja\b|\bsolicito\s+(?:la\s+)?baja\b|\bstop\b)/.test(
      text
    )
  ) {
    // A no-outreach request has compliance priority over every other signal.
    return 'do_not_contact';
  }
  if (frustration) {
    return 'frustration';
  }
  if (
    /\b(?:cotiz[a-z]*|precio|costo|cuest(?:a|an|e|en)|visita|cita|instal[a-z]*|panel(?:es)?|financ[a-z]*)\b/.test(
      text
    ) ||
    /(?:\b(?:mi|el|un)\s+recibo\b|\brecibo\s+(?:de\s+)?(?:luz|cfe|electricidad|electrico)\b)/.test(
      text
    )
  ) {
    return 'commercial_request';
  }
  if (
    text.includes('?') ||
    /^(?:como|cuando|cuanto|cual|donde|por que|puede|podria|quiero saber)\b/.test(
      text
    )
  ) {
    return 'question';
  }
  return 'other';
}

function errorCode(value) {
  const text = compactWhitespace(value).toLowerCase();
  if (!text) return 'unspecified';
  if (/\b132001\b/.test(text)) return 'meta_template_missing';
  if (/\b132012\b/.test(text)) return 'meta_template_parameters';
  if (/experiment|healthy ecosystem engagement/.test(text)) {
    return 'meta_policy';
  }
  if (/no conversation for contact/.test(text)) return 'conversation_lookup';
  if (
    /\b(?:401|403|auth(?:entication|orization)?|forbidden|unauthori[sz]ed)\b/.test(
      text
    )
  ) {
    return 'authentication';
  }
  if (/\b(?:429|rate.?limit|too many requests)\b/.test(text)) {
    return 'rate_limit';
  }
  if (/\b(?:timeout|timed out|etimedout)\b/.test(text)) return 'timeout';
  if (
    /\b(?:dns|econn(?:refused|reset|aborted)?|enotfound|eai_again|fetch|network|socket)\b/.test(
      text
    )
  ) {
    return 'network';
  }
  if (/send_error|send error|error de env[ií]o/.test(text)) return 'send_error';
  return 'other';
}

function recentMessages(messages, limit = 5) {
  return messages.slice(-limit).map((message) => ({
    sender: safeEnum(message.sender_type, MESSAGE_SENDERS),
    type: safeEnum(message.content_type, MESSAGE_CONTENT_TYPES),
    status: safeEnum(message.status, MESSAGE_STATUSES),
    ai_generated: Boolean(message.ai_generated),
    at: message.created_at,
    signal: messageSignal(message),
  }));
}

function laterConfirmedOutbound(messages, target, requireHuman = false) {
  const targetTime = asInstant(target.created_at);
  if (targetTime === null) return false;
  return messages.some((message) => {
    const messageTime = asInstant(message.created_at);
    return (
      messageTime !== null &&
      messageTime > targetTime &&
      OUTBOUND_SENDERS.has(message.sender_type) &&
      (!requireHuman ||
        (message.sender_type === 'agent' && message.ai_generated === false)) &&
      RESOLVING_OUTBOUND_STATUSES.has(message.status)
    );
  });
}

function fixedPositiveIntegerOption(value, expected) {
  if (value === undefined || value === expected) {
    return expected;
  }
  throw new Error('La auditoría recibió opciones de límites inválidas.');
}

function validateTemporalOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('La auditoría recibió opciones temporales inválidas.');
  }

  const optionOrDefault = (key, fallback) =>
    options[key] === undefined ? fallback : options[key];
  const values = {
    nowMs: optionOrDefault('nowMs', Date.now()),
    responseSlaMinutes: optionOrDefault('responseSlaMinutes', 30),
    staleSentMinutes: optionOrDefault('staleSentMinutes', 120),
    pendingGraceMinutes: optionOrDefault('pendingGraceMinutes', 15),
    incidentLookbackDays: optionOrDefault('incidentLookbackDays', 30),
  };
  const positive = [
    values.responseSlaMinutes,
    values.staleSentMinutes,
    values.incidentLookbackDays,
  ];
  const minuteValues = [
    values.responseSlaMinutes,
    values.staleSentMinutes,
    values.pendingGraceMinutes,
  ];

  if (
    !Number.isSafeInteger(values.nowMs) ||
    values.nowMs < 0 ||
    positive.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    !Number.isSafeInteger(values.pendingGraceMinutes) ||
    values.pendingGraceMinutes < 0 ||
    values.incidentLookbackDays > 365 ||
    minuteValues.some((value) => value > MAX_TEMPORAL_MINUTES)
  ) {
    throw new Error('La auditoría recibió opciones temporales inválidas.');
  }

  return values;
}

function sortByNewest(rows, field = 'created_at') {
  return [...rows].sort(
    (a, b) =>
      compareCodeUnits(asInstant(b[field]), asInstant(a[field])) ||
      compareCodeUnits(a.id, b.id)
  );
}

/**
 * Build a deterministic, PII-minimised snapshot for Hermes's `monitor`
 * change detector. There is intentionally no generated timestamp and ages
 * are bucketed, so an unchanged incident does not wake the agent every tick.
 */
export function buildAuditSnapshot(rawData, options = {}) {
  const referenceFor = referenceFactory(options.referenceKey);
  const data = normaliseInput(rawData);
  requireUniqueIdentifiers(data);
  for (const log of data.automationLogs) {
    requireIdentifier(log.automation_id);
  }
  for (const pending of data.pendingExecutions) {
    requireIdentifier(pending.automation_id);
  }
  requireSourceRelationships(data);
  const {
    nowMs,
    responseSlaMinutes,
    staleSentMinutes,
    pendingGraceMinutes,
    incidentLookbackDays: configuredLookbackDays,
  } = validateTemporalOptions(options);
  const maxAwaitingConversations = fixedPositiveIntegerOption(
    options.maxAwaitingConversations,
    3
  );
  const maxRecentConversations = fixedPositiveIntegerOption(
    options.maxRecentConversations,
    1
  );
  const maxTechnicalIncidents = fixedPositiveIntegerOption(
    options.maxTechnicalIncidents,
    1
  );
  const messagesPerConversation = fixedPositiveIntegerOption(
    options.messagesPerConversation,
    1
  );
  const incidentLookbackDays = configuredLookbackDays;
  const incidentCutoff =
    BigInt(nowMs - incidentLookbackDays * 86_400_000) *
    NANOSECONDS_PER_MILLISECOND;
  const nowInstant = BigInt(nowMs) * NANOSECONDS_PER_MILLISECOND;
  const isCurrentIncident = (value) => {
    const instant = asInstant(value);
    return (
      instant !== null && instant >= incidentCutoff && instant <= nowInstant
    );
  };

  for (const conversation of data.conversations) {
    requireSourceState(CONVERSATION_STATUSES.has(conversation.status));
    requireSourceState(typeof conversation.ai_autoreply_disabled === 'boolean');
    if (conversation.assigned_agent_id != null) {
      requireSourceState(typeof conversation.assigned_agent_id === 'string');
      requireIdentifier(conversation.assigned_agent_id);
    }
    requireSourceState(
      conversation.ai_handoff_summary == null ||
        (typeof conversation.ai_handoff_summary === 'string' &&
          compactWhitespace(conversation.ai_handoff_summary).length > 0)
    );
    assertNotFuture(conversation.last_message_at, nowMs, true);
  }
  for (const message of data.messages) {
    requireSourceState(MESSAGE_SENDERS.has(message.sender_type));
    requireSourceState(MESSAGE_STATUSES.has(message.status));
    requireSourceState(
      message.sender_type === 'customer'
        ? ['received', 'delivered', 'read'].includes(message.status)
        : message.status !== 'received'
    );
    requireSourceState(
      typeof message.content_type === 'string' &&
        message.content_type.length > 0 &&
        message.content_type.length <= 64
    );
    requireSourceState(
      message.content_text == null || typeof message.content_text === 'string'
    );
    requireSourceState(
      message.status_error == null || typeof message.status_error === 'string'
    );
    requireSourceState(typeof message.ai_generated === 'boolean');
  }
  for (const log of data.automationLogs) {
    requireSourceState(AUTOMATION_LOG_STATUSES.has(log.status));
    requireSourceState(
      log.error_message == null || typeof log.error_message === 'string'
    );
    requireSourceState(Array.isArray(log.steps_executed));
    for (const step of log.steps_executed) {
      requireSourceState(
        step &&
          typeof step === 'object' &&
          !Array.isArray(step) &&
          AUTOMATION_STEP_STATUSES.has(step.status) &&
          typeof step.step_type === 'string' &&
          step.step_type.length > 0 &&
          step.step_type.length <= 64 &&
          (step.detail == null || typeof step.detail === 'string')
      );
    }
    assertNotFuture(log.created_at, nowMs);
  }
  for (const pending of data.pendingExecutions) {
    requireSourceState(pending.status === 'pending');
    assertNotFuture(pending.created_at, nowMs);
    asTime(pending.run_at);
  }
  for (const run of data.flowRuns) {
    requireSourceState(FLOW_RUN_STATUSES.has(run.status));
    requireSourceState(
      run.end_reason == null || typeof run.end_reason === 'string'
    );
    assertNotFuture(run.last_advanced_at, nowMs);
  }
  for (const endpoint of data.webhookEndpoints) {
    requireSourceState(typeof endpoint.is_active === 'boolean');
    requireSourceState(
      Number.isSafeInteger(endpoint.failure_count) &&
        endpoint.failure_count >= 0
    );
    requireSourceState(
      endpoint.last_error == null || typeof endpoint.last_error === 'string'
    );
    assertNotFuture(endpoint.last_delivery_at, nowMs, true);
  }
  for (const config of data.whatsappConfigs) {
    requireSourceState(WHATSAPP_STATUSES.has(config.status));
    requireSourceState(
      config.last_registration_error == null ||
        typeof config.last_registration_error === 'string'
    );
  }

  const messagesByConversation = new Map();

  for (const message of data.messages) {
    assertNotFuture(message.created_at, nowMs);
    if (!messagesByConversation.has(message.conversation_id)) {
      messagesByConversation.set(message.conversation_id, []);
    }
    messagesByConversation.get(message.conversation_id).push(message);
  }
  for (const messages of messagesByConversation.values()) {
    messages.sort(
      (a, b) =>
        compareCodeUnits(asInstant(a.created_at), asInstant(b.created_at)) ||
        compareCodeUnits(a.id, b.id)
    );
  }

  const interactionRows = [];
  const awaitingResponse = [];
  const awaitingInstants = new WeakMap();

  for (const conversation of data.conversations) {
    const messages = messagesByConversation.get(conversation.id) ?? [];
    if (messages.length === 0) continue;
    const latest = messages.at(-1);
    const latestTime = asInstant(latest.created_at);
    if (latestTime === null) continue;
    const latestCustomer = messages.findLast(
      (message) => message.sender_type === 'customer'
    );
    const latestCustomerSignal = latestCustomer
      ? messageSignal(latestCustomer)
      : null;

    const shared = {
      conversation_ref: referenceFor(conversation.id),
      status: conversation.status,
      assigned: Boolean(conversation.assigned_agent_id),
      ai_disabled: Boolean(conversation.ai_autoreply_disabled),
      ai_handoff: Boolean(conversation.ai_handoff_summary),
      last_message_at: latest.created_at,
      latest_sender: safeEnum(latest.sender_type, MESSAGE_SENDERS),
      recent_messages: recentMessages(messages, messagesPerConversation),
    };

    interactionRows.push(shared);

    if (
      ['open', 'pending'].includes(conversation.status) &&
      latestCustomer &&
      (!NON_ACTIONABLE_CUSTOMER_SIGNALS.has(latestCustomerSignal) ||
        Boolean(conversation.ai_handoff_summary)) &&
      !laterConfirmedOutbound(
        messages,
        latestCustomer,
        Boolean(conversation.ai_handoff_summary)
      ) &&
      elapsedAtLeast(
        latestCustomer.created_at,
        nowMs,
        responseSlaMinutes * 60_000
      )
    ) {
      const bucket = ageBucket(latestCustomer.created_at, nowMs);
      const waitingRow = {
        incident_key: `awaiting:${referenceFor(conversation.id)}`,
        severity: severityForAge(bucket),
        age_bucket: bucket,
        assigned: shared.assigned,
        ai_disabled: shared.ai_disabled,
        ai_handoff: shared.ai_handoff,
        status: conversation.status,
        customer_signal: latestCustomerSignal,
        latest_content_type: safeEnum(
          latestCustomer.content_type,
          MESSAGE_CONTENT_TYPES
        ),
        conversation_ref: shared.conversation_ref,
        recent_messages: shared.recent_messages,
      };
      awaitingResponse.push(waitingRow);
      awaitingInstants.set(waitingRow, asInstant(latestCustomer.created_at));
    }
  }

  const awaitingRefs = new Set(
    awaitingResponse.map((incident) => incident.conversation_ref)
  );
  const eligibleRecentInteractions = interactionRows
    .filter(
      (interaction) =>
        ['open', 'pending'].includes(interaction.status) &&
        !awaitingRefs.has(interaction.conversation_ref)
    )
    .sort(
      (a, b) =>
        compareCodeUnits(
          asInstant(b.last_message_at),
          asInstant(a.last_message_at)
        ) || compareCodeUnits(a.conversation_ref, b.conversation_ref)
    );
  const recentInteractions = eligibleRecentInteractions.slice(
    0,
    maxRecentConversations
  );

  const failedMessages = [];
  const staleSentMessages = [];
  for (const message of data.messages) {
    if (!OUTBOUND_SENDERS.has(message.sender_type)) continue;
    if (!isCurrentIncident(message.created_at)) continue;

    const bucket = ageBucket(message.created_at, nowMs);
    const common = {
      conversation_ref: referenceFor(message.conversation_id),
      sender: safeEnum(message.sender_type, MESSAGE_SENDERS),
      content_type: safeEnum(message.content_type, MESSAGE_CONTENT_TYPES),
      ai_generated: Boolean(message.ai_generated),
      age_bucket: bucket,
      at: message.created_at,
    };

    if (message.status === 'failed') {
      failedMessages.push({
        incident_key: `message-failed:${referenceFor(message.id)}`,
        severity: 'high',
        reason_code: errorCode(message.status_error),
        ...common,
      });
    } else if (
      ['sending', 'sent'].includes(message.status) &&
      elapsedAtLeast(message.created_at, nowMs, staleSentMinutes * 60_000)
    ) {
      staleSentMessages.push({
        incident_key: `message-stale:${referenceFor(message.id)}`,
        severity: 'medium',
        delivery_status: message.status,
        ...common,
      });
    }
  }

  const automationFailureGroups = new Map();
  for (const log of sortByNewest(data.automationLogs)) {
    if (!isCurrentIncident(log.created_at)) continue;
    const failedSteps = log.steps_executed.filter(
      (step) => step.status === 'failed'
    );
    const logError = compactWhitespace(log.error_message);
    if (failedSteps.length === 0 && (log.status === 'failed' || logError)) {
      failedSteps.push(null);
    }
    const seenGroups = new Set();
    for (const step of failedSteps) {
      const failureCode = errorCode(
        compactWhitespace(step?.detail) || logError
      );
      const stepType = step
        ? safeEnum(step.step_type, AUTOMATION_STEP_TYPES)
        : null;
      const automationRef = referenceFor(log.automation_id);
      const groupKey = `${automationRef}\u0000${failureCode}\u0000${stepType ?? ''}`;
      if (seenGroups.has(groupKey)) continue;
      seenGroups.add(groupKey);
      const existing = automationFailureGroups.get(groupKey);
      if (existing) {
        existing.occurrences += 1;
        continue;
      }
      automationFailureGroups.set(groupKey, {
        incident_key: `automation-failed:${referenceFor(groupKey)}`,
        severity: 'high',
        automation_ref: automationRef,
        error_code: failureCode,
        step_type: stepType,
        occurrences: 1,
        latest_at: log.created_at,
      });
    }
  }
  const automationFailures = [...automationFailureGroups.values()];

  const overdueAutomationExecutions = data.pendingExecutions
    .filter((row) => {
      return (
        row.status === 'pending' &&
        elapsedAtLeast(row.run_at, nowMs, pendingGraceMinutes * 60_000)
      );
    })
    .map((row) => {
      const bucket = ageBucket(row.run_at, nowMs);
      return {
        incident_key: `automation-overdue:${referenceFor(row.id)}`,
        severity: 'high',
        automation_ref: referenceFor(
          row.automation_id || `pending-execution:${row.id ?? ''}`
        ),
        age_bucket: bucket,
        run_at: row.run_at,
      };
    });

  const flowsById = new Map(data.flows.map((flow) => [flow.id, flow]));
  const flowIncidents = [];
  const flowIncidentInstants = new WeakMap();
  for (const run of data.flowRuns) {
    const flow = flowsById.get(run.flow_id);
    if (run.status === 'failed') {
      if (!isCurrentIncident(run.last_advanced_at)) continue;
      const incident = {
        incident_key: `flow-failed:${referenceFor(run.id)}`,
        severity: 'high',
        flow_ref: referenceFor(run.flow_id || `flow-run:${run.id ?? ''}`),
        reason_code: errorCode(run.end_reason),
        conversation_ref: run.conversation_id
          ? referenceFor(run.conversation_id)
          : null,
      };
      flowIncidents.push(incident);
      flowIncidentInstants.set(incident, asInstant(run.last_advanced_at));
      continue;
    }
    if (run.status !== 'active') continue;
    const lastAdvancedAt = asInstant(run.last_advanced_at);
    if (lastAdvancedAt === null) continue;
    const configuredTimeout = flow?.fallback_policy?.on_timeout_hours ?? 24;
    const timeoutHours =
      typeof configuredTimeout === 'number' &&
      Number.isSafeInteger(configuredTimeout) &&
      configuredTimeout > 0 &&
      configuredTimeout <= MAX_FLOW_TIMEOUT_HOURS
        ? configuredTimeout
        : 24;
    if (
      !elapsedAtLeast(
        run.last_advanced_at,
        nowMs,
        timeoutHours * 3_600_000 + pendingGraceMinutes * 60_000
      )
    ) {
      continue;
    }
    const bucket = ageBucket(run.last_advanced_at, nowMs);
    const incident = {
      incident_key: `flow-stalled:${referenceFor(run.id)}`,
      severity: 'high',
      flow_ref: referenceFor(run.flow_id || `flow-run:${run.id ?? ''}`),
      reason_code: 'timeout',
      age_bucket: bucket,
      conversation_ref: run.conversation_id
        ? referenceFor(run.conversation_id)
        : null,
    };
    flowIncidents.push(incident);
    flowIncidentInstants.set(incident, asInstant(run.last_advanced_at));
  }

  const webhookIncidents = data.webhookEndpoints
    .filter(
      (endpoint) =>
        !endpoint.is_active || Number(endpoint.failure_count ?? 0) > 0
    )
    .map((endpoint) => ({
      incident_key: `webhook:${referenceFor(endpoint.id)}`,
      severity: endpoint.is_active ? 'medium' : 'high',
      active: Boolean(endpoint.is_active),
      consecutive_failures: Number(endpoint.failure_count ?? 0),
      last_delivery_at: canonicalTimestamp(endpoint.last_delivery_at, true),
    }));

  const whatsappIncidents =
    data.whatsappConfigs.length === 0
      ? [
          {
            incident_key: `whatsapp:${referenceFor('missing-configuration')}`,
            severity: 'critical',
            status: 'unknown',
            has_registration_error: false,
          },
        ]
      : data.whatsappConfigs
          .filter(
            (config) =>
              config.status !== 'connected' ||
              compactWhitespace(config.last_registration_error).length > 0
          )
          .map((config) => ({
            incident_key: `whatsapp:${referenceFor(config.id)}`,
            severity: config.status === 'connected' ? 'medium' : 'critical',
            status: safeEnum(config.status, WHATSAPP_STATUSES),
            has_registration_error:
              compactWhitespace(config.last_registration_error).length > 0,
          }));

  const byIncidentKey = (a, b) =>
    compareCodeUnits(a.incident_key, b.incident_key);
  const severityPriority = new Map([
    ['critical', 4],
    ['high', 3],
    ['medium', 2],
    ['low', 1],
  ]);
  const bySeverity = (a, b) =>
    (severityPriority.get(b.severity) ?? 0) -
      (severityPriority.get(a.severity) ?? 0) || byIncidentKey(a, b);
  const agePriority = new Map([
    ['<30m', 0],
    ['30m-2h', 1],
    ['2h-24h', 2],
    ['1d-7d', 3],
    ['7d+', 4],
  ]);
  const customerSignalPriority = new Map([
    ['do_not_contact', 6],
    ['frustration', 5],
    ['commercial_request', 4],
    ['question', 3],
    ['media', 2],
    ['other', 1],
    ['closure', 0],
    ['empty', 0],
  ]);
  const byAwaitingPriority = (a, b) =>
    Number(b.ai_handoff) - Number(a.ai_handoff) ||
    (agePriority.get(b.age_bucket) ?? 0) -
      (agePriority.get(a.age_bucket) ?? 0) ||
    (customerSignalPriority.get(b.customer_signal) ?? 0) -
      (customerSignalPriority.get(a.customer_signal) ?? 0) ||
    compareCodeUnits(awaitingInstants.get(a), awaitingInstants.get(b)) ||
    Number(a.assigned) - Number(b.assigned) ||
    byIncidentKey(a, b);
  const byNewestIncident = (field) => (a, b) =>
    compareCodeUnits(asInstant(b[field]), asInstant(a[field])) ||
    byIncidentKey(a, b);
  const byOldestIncident = (field) => (a, b) =>
    compareCodeUnits(asInstant(a[field]), asInstant(b[field])) ||
    byIncidentKey(a, b);
  const limited = (rows, limit) => rows.slice(0, Math.max(0, limit));
  const sortedAwaiting = awaitingResponse.sort(byAwaitingPriority);
  const sortedFailedMessages = failedMessages.sort(byNewestIncident('at'));
  const sortedStaleMessages = staleSentMessages.sort(byOldestIncident('at'));
  const sortedAutomationFailures = automationFailures.sort(
    byNewestIncident('latest_at')
  );
  const sortedOverdueExecutions = overdueAutomationExecutions.sort(
    byOldestIncident('run_at')
  );
  const sortedFlowIncidents = flowIncidents.sort(
    (a, b) =>
      Number(b.incident_key.startsWith('flow-failed:')) -
        Number(a.incident_key.startsWith('flow-failed:')) ||
      (a.incident_key.startsWith('flow-failed:')
        ? compareCodeUnits(
            flowIncidentInstants.get(b),
            flowIncidentInstants.get(a)
          )
        : compareCodeUnits(
            flowIncidentInstants.get(a),
            flowIncidentInstants.get(b)
          )) ||
      byIncidentKey(a, b)
  );
  const sortedWebhookIncidents = webhookIncidents.sort(bySeverity);
  const sortedWhatsappIncidents = whatsappIncidents.sort(bySeverity);

  return canonicalSnapshotTimes({
    schema_version: 2,
    privacy: {
      pii_redaction: 'structured_only',
      raw_customer_identifiers_included: false,
      customer_message_text_included: false,
      untrusted_free_text_included: false,
    },
    metrics: {
      contacts: data.contacts.length,
      conversations: data.conversations.length,
      messages: data.messages.length,
      open_conversations: data.conversations.filter(
        (row) => row.status === 'open'
      ).length,
      pending_conversations: data.conversations.filter(
        (row) => row.status === 'pending'
      ).length,
    },
    customer_review: {
      awaiting_response: limited(sortedAwaiting, maxAwaitingConversations),
      recent_interactions: recentInteractions,
    },
    technical: {
      failed_messages: limited(sortedFailedMessages, maxTechnicalIncidents),
      stale_sent_messages: limited(sortedStaleMessages, maxTechnicalIncidents),
      automation_failures: limited(
        sortedAutomationFailures,
        maxTechnicalIncidents
      ),
      overdue_automation_executions: limited(
        sortedOverdueExecutions,
        maxTechnicalIncidents
      ),
      flow_incidents: limited(sortedFlowIncidents, maxTechnicalIncidents),
      webhook_incidents: limited(sortedWebhookIncidents, maxTechnicalIncidents),
      whatsapp_incidents: limited(
        sortedWhatsappIncidents,
        maxTechnicalIncidents
      ),
    },
    omitted: {
      awaiting_response: Math.max(
        0,
        sortedAwaiting.length - maxAwaitingConversations
      ),
      recent_interactions: Math.max(
        0,
        eligibleRecentInteractions.length - maxRecentConversations
      ),
      failed_messages: Math.max(
        0,
        sortedFailedMessages.length - maxTechnicalIncidents
      ),
      stale_sent_messages: Math.max(
        0,
        sortedStaleMessages.length - maxTechnicalIncidents
      ),
      automation_failures: Math.max(
        0,
        sortedAutomationFailures.length - maxTechnicalIncidents
      ),
      overdue_automation_executions: Math.max(
        0,
        sortedOverdueExecutions.length - maxTechnicalIncidents
      ),
      flow_incidents: Math.max(
        0,
        sortedFlowIncidents.length - maxTechnicalIncidents
      ),
      webhook_incidents: Math.max(
        0,
        sortedWebhookIncidents.length - maxTechnicalIncidents
      ),
      whatsapp_incidents: Math.max(
        0,
        sortedWhatsappIncidents.length - maxTechnicalIncidents
      ),
    },
  });
}
