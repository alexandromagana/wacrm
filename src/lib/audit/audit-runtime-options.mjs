const OUTPUT_LIMITS = Object.freeze({
  maxAwaitingConversations: 3,
  maxRecentConversations: 1,
  maxTechnicalIncidents: 1,
  messagesPerConversation: 1,
});

function configInteger(config, key, fallback, minimum, maximum) {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Configuración temporal inválida.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Configuración temporal inválida.');
  }
  return parsed;
}

export function parseAuditOptions(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Configuración temporal inválida.');
  }
  for (const key of [
    'CRM_AUDIT_AWAITING_CONVERSATIONS',
    'CRM_AUDIT_RECENT_CONVERSATIONS',
    'CRM_AUDIT_TECHNICAL_INCIDENTS',
    'CRM_AUDIT_MESSAGES_PER_CONVERSATION',
  ]) {
    if (Object.hasOwn(config, key))
      throw new Error('Los límites de salida son fijos.');
  }
  const values = {
    historyDays: configInteger(config, 'CRM_AUDIT_HISTORY_DAYS', 90, 1, 365),
    incidentLookbackDays: configInteger(
      config,
      'CRM_AUDIT_INCIDENT_LOOKBACK_DAYS',
      30,
      1,
      365
    ),
    responseSlaMinutes: configInteger(
      config,
      'CRM_AUDIT_RESPONSE_SLA_MINUTES',
      30,
      1,
      525_600
    ),
    staleSentMinutes: configInteger(
      config,
      'CRM_AUDIT_STALE_SENT_MINUTES',
      120,
      1,
      525_600
    ),
    pendingGraceMinutes: configInteger(
      config,
      'CRM_AUDIT_PENDING_GRACE_MINUTES',
      15,
      0,
      525_600
    ),
  };
  if (
    values.historyDays * 1440 < values.incidentLookbackDays * 1440 + 30 ||
    values.historyDays * 1440 < values.responseSlaMinutes + 30 ||
    values.incidentLookbackDays * 1440 < values.staleSentMinutes + 30
  ) {
    throw new Error('La configuración no garantiza cobertura y solapamiento.');
  }
  return { ...values, ...OUTPUT_LIMITS };
}
