import { describe, expect, it } from 'vitest';

import { buildAuditSnapshot as buildAuditSnapshotRaw } from './crm-auditor.mjs';

const NOW = Date.parse('2026-09-04T05:00:00.000Z');
const REFERENCE_KEY = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo';
const buildAuditSnapshot = (
  rawData: Record<string, unknown>,
  options: Record<string, unknown> = {}
) =>
  buildAuditSnapshotRaw(rawData, {
    referenceKey: REFERENCE_KEY,
    ...options,
  });

function baseData() {
  return {
    contacts: [{ id: 'contact-1' }],
    conversations: [
      {
        id: 'conversation-1',
        contact_id: 'contact-1',
        status: 'closed',
        assigned_agent_id: null,
        ai_autoreply_disabled: false,
        ai_handoff_summary: null,
      },
    ],
    messages: [],
    automationLogs: [],
    pendingExecutions: [],
    flows: [],
    flowRuns: [],
    webhookEndpoints: [],
    whatsappConfigs: [],
  };
}

describe('CRM auditor source validation', () => {
  it('fails closed before a non-array collection length can enter metrics', () => {
    const injected = 'private-contact@example.test';
    const data = {
      ...baseData(),
      contacts: { length: injected },
    };

    let message = '';
    try {
      buildAuditSnapshot(data, { nowMs: NOW });
    } catch (error) {
      message = String(error);
    }

    expect(message).toMatch(/colecciones.*inválidas/i);
    expect(message).not.toContain(injected);
  });

  it('does not treat an AI-generated agent row as a human handoff response', () => {
    const data = {
      ...baseData(),
      conversations: [
        {
          id: 'conversation-human-handoff',
          contact_id: 'contact-1',
          status: 'open',
          assigned_agent_id: 'agent-1',
          ai_autoreply_disabled: true,
          ai_handoff_summary: 'handoff requested',
        },
      ],
      messages: [
        {
          id: 'customer-question',
          conversation_id: 'conversation-human-handoff',
          sender_type: 'customer',
          content_type: 'text',
          content_text: 'Necesito atención humana',
          status: 'delivered',
          created_at: '2026-09-04T03:00:00.000Z',
          ai_generated: false,
        },
        {
          id: 'ai-agent-reply',
          conversation_id: 'conversation-human-handoff',
          sender_type: 'agent',
          content_type: 'text',
          content_text: 'Respuesta automática',
          status: 'read',
          created_at: '2026-09-04T03:01:00.000Z',
          ai_generated: true,
        },
      ],
    };

    expect(
      buildAuditSnapshot(data, { nowMs: NOW }).customer_review.awaiting_response
    ).toHaveLength(1);
  });

  it('fails closed on a future-dated source message', () => {
    const data = {
      ...baseData(),
      conversations: [
        {
          id: 'conversation-future',
          contact_id: 'contact-1',
          status: 'open',
          assigned_agent_id: null,
          ai_autoreply_disabled: false,
          ai_handoff_summary: null,
        },
      ],
      messages: [
        {
          id: 'future-message',
          conversation_id: 'conversation-future',
          sender_type: 'customer',
          content_type: 'text',
          content_text: 'Pregunta futura',
          status: 'delivered',
          created_at: '2026-09-04T05:00:00.001Z',
          ai_generated: false,
        },
      ],
    };

    expect(() => buildAuditSnapshot(data, { nowMs: NOW })).toThrow(
      /timestamp.*futuro/i
    );
  });

  it.each([
    [
      'conversation',
      {
        conversations: [
          {
            id: 'conversation-future',
            contact_id: 'contact-1',
            status: 'open',
            assigned_agent_id: null,
            ai_autoreply_disabled: false,
            ai_handoff_summary: null,
            last_message_at: '2026-09-04T05:00:00.001Z',
          },
        ],
      },
    ],
    [
      'automation log',
      {
        automationLogs: [
          {
            id: 'log-future',
            automation_id: 'automation-1',
            status: 'failed',
            error_message: 'failure',
            steps_executed: [],
            created_at: '2026-09-04T05:00:00.001Z',
          },
        ],
      },
    ],
    [
      'pending execution creation',
      {
        pendingExecutions: [
          {
            id: 'pending-future',
            automation_id: 'automation-1',
            status: 'pending',
            run_at: '2026-09-05T05:00:00.000Z',
            created_at: '2026-09-04T05:00:00.001Z',
          },
        ],
      },
    ],
    [
      'flow run',
      {
        flows: [
          {
            id: 'flow-1',
            fallback_policy: { on_timeout_hours: 1 },
          },
        ],
        flowRuns: [
          {
            id: 'flow-run-future',
            flow_id: 'flow-1',
            conversation_id: 'conversation-1',
            status: 'active',
            last_advanced_at: '2026-09-04T05:00:00.001Z',
            end_reason: null,
          },
        ],
      },
    ],
    [
      'webhook delivery',
      {
        webhookEndpoints: [
          {
            id: 'webhook-future',
            is_active: true,
            failure_count: 0,
            last_delivery_at: '2026-09-04T05:00:00.001Z',
          },
        ],
      },
    ],
  ])('fails closed on a future-dated %s timestamp', (_label, patch) => {
    expect(() =>
      buildAuditSnapshot({ ...baseData(), ...patch }, { nowMs: NOW })
    ).toThrow(/timestamp.*futuro/i);
  });

  it('does not classify a closing acknowledgement as awaiting a response', () => {
    const data = {
      ...baseData(),
      conversations: [
        {
          id: 'conversation-closed-signal',
          contact_id: 'contact-1',
          status: 'open',
          assigned_agent_id: null,
          ai_autoreply_disabled: false,
          ai_handoff_summary: null,
        },
      ],
      messages: [
        {
          id: 'customer-closure',
          conversation_id: 'conversation-closed-signal',
          sender_type: 'customer',
          content_type: 'text',
          content_text: 'Gracias, todo listo.',
          status: 'delivered',
          created_at: '2026-09-04T03:00:00.000Z',
          ai_generated: false,
        },
      ],
    };

    const snapshot = buildAuditSnapshot(data, { nowMs: NOW });

    expect(snapshot.customer_review.awaiting_response).toEqual([]);
    expect(
      snapshot.customer_review.recent_interactions[0].recent_messages[0]
    ).toMatchObject({ signal: 'closure' });
  });

  it.each([
    ['No me contacten de nuevo', 'do_not_contact'],
    ['No me escriban más', 'do_not_contact'],
    ['Estoy molesta con el servicio', 'frustration'],
    ['Estoy enojado con el servicio', 'frustration'],
    ['Pésimo servicio', 'frustration'],
    ['¿El precio baja si instalo más paneles?', 'commercial_request'],
    ['No me contactaron y sigo esperando la cotización', 'commercial_request'],
  ])('classifies Spanish customer signal %j as %s', (text, expectedSignal) => {
    const data = {
      ...baseData(),
      conversations: [
        {
          id: 'conversation-signal',
          contact_id: 'contact-1',
          status: 'open',
          assigned_agent_id: null,
          ai_autoreply_disabled: false,
          ai_handoff_summary: null,
        },
      ],
      messages: [
        {
          id: 'customer-signal',
          conversation_id: 'conversation-signal',
          sender_type: 'customer',
          content_type: 'text',
          content_text: text,
          status: 'delivered',
          created_at: '2026-09-04T03:00:00.000Z',
          ai_generated: false,
        },
      ],
    };

    const review = buildAuditSnapshot(data, { nowMs: NOW }).customer_review;
    const row = review.awaiting_response[0] ?? review.recent_interactions[0];

    expect(row.recent_messages[0].signal).toBe(expectedSignal);
  });

  it.each([
    ['Authentication failed', 'authentication'],
    ['ECONNREFUSED 127.0.0.1', 'network'],
    ['ETIMEDOUT', 'timeout'],
  ])(
    'classifies common delivery error %j as %s',
    (statusError, expectedCode) => {
      const data = {
        ...baseData(),
        messages: [
          {
            id: 'failed-message',
            conversation_id: 'conversation-1',
            sender_type: 'agent',
            content_type: 'text',
            content_text: '',
            status: 'failed',
            status_error: statusError,
            created_at: '2026-09-04T04:00:00.000Z',
            ai_generated: false,
          },
        ],
      };

      const incident = buildAuditSnapshot(data, { nowMs: NOW }).technical
        .failed_messages[0];

      expect(incident.reason_code).toBe(expectedCode);
    }
  );

  it.each([
    ['nowMs', Number.NaN],
    ['responseSlaMinutes', 0],
    ['responseSlaMinutes', Number.MAX_VALUE],
    ['staleSentMinutes', Number.POSITIVE_INFINITY],
    ['pendingGraceMinutes', -1],
    ['pendingGraceMinutes', 0.5],
    ['responseSlaMinutes', 1.5],
    ['incidentLookbackDays', 'not-a-number'],
    ['incidentLookbackDays', 1.5],
    ['incidentLookbackDays', 366],
  ])('fails closed on an invalid temporal option %s', (key, value) => {
    expect(() =>
      buildAuditSnapshot(baseData(), { nowMs: NOW, [key]: value })
    ).toThrow(/opciones temporales.*inválidas/i);
  });

  it.each([
    [
      'conversation status',
      {
        conversations: [
          {
            id: 'conversation-invalid',
            contact_id: 'contact-1',
            status: 'mystery',
            assigned_agent_id: null,
            ai_autoreply_disabled: false,
            ai_handoff_summary: null,
            last_message_at: null,
          },
        ],
      },
    ],
    [
      'conversation handoff summary',
      {
        conversations: [
          {
            id: 'conversation-1',
            contact_id: 'contact-1',
            status: 'open',
            assigned_agent_id: null,
            ai_autoreply_disabled: false,
            ai_handoff_summary: [],
            last_message_at: null,
          },
        ],
      },
    ],
    [
      'conversation assignee',
      {
        conversations: [
          {
            id: 'conversation-1',
            contact_id: 'contact-1',
            status: 'open',
            assigned_agent_id: [],
            ai_autoreply_disabled: false,
            ai_handoff_summary: null,
            last_message_at: null,
          },
        ],
      },
    ],
    [
      'message sender',
      {
        messages: [
          {
            id: 'message-invalid',
            conversation_id: 'conversation-1',
            sender_type: 'mystery',
            content_type: 'text',
            content_text: '',
            status: 'delivered',
            created_at: '2026-09-04T04:00:00.000Z',
            ai_generated: false,
          },
        ],
      },
    ],
    [
      'message status',
      {
        messages: [
          {
            id: 'message-invalid',
            conversation_id: 'conversation-1',
            sender_type: 'customer',
            content_type: 'text',
            content_text: '',
            status: 'mystery',
            created_at: '2026-09-04T04:00:00.000Z',
            ai_generated: false,
          },
        ],
      },
    ],
    [
      'message AI flag',
      {
        messages: [
          {
            id: 'message-invalid',
            conversation_id: 'conversation-1',
            sender_type: 'agent',
            content_type: 'text',
            content_text: '',
            status: 'delivered',
            created_at: '2026-09-04T04:00:00.000Z',
            ai_generated: 'false',
          },
        ],
      },
    ],
    [
      'message content text',
      {
        messages: [
          {
            id: 'message-invalid-content',
            conversation_id: 'conversation-1',
            sender_type: 'customer',
            content_type: 'text',
            content_text: { text: 'cotización' },
            status: 'delivered',
            status_error: null,
            created_at: '2026-09-04T04:00:00.000Z',
            ai_generated: false,
          },
        ],
      },
    ],
    [
      'message status error',
      {
        messages: [
          {
            id: 'message-invalid-error',
            conversation_id: 'conversation-1',
            sender_type: 'agent',
            content_type: 'text',
            content_text: '',
            status: 'failed',
            status_error: { code: 401 },
            created_at: '2026-09-04T04:00:00.000Z',
            ai_generated: false,
          },
        ],
      },
    ],
    [
      'automation status',
      {
        automationLogs: [
          {
            id: 'log-invalid',
            automation_id: 'automation-1',
            status: 'mystery',
            error_message: null,
            steps_executed: [],
            created_at: '2026-09-04T04:00:00.000Z',
          },
        ],
      },
    ],
    [
      'automation error',
      {
        automationLogs: [
          {
            id: 'log-invalid',
            automation_id: 'automation-1',
            status: 'partial',
            error_message: 0,
            steps_executed: [],
            created_at: '2026-09-04T04:00:00.000Z',
          },
        ],
      },
    ],
    [
      'automation step collection',
      {
        automationLogs: [
          {
            id: 'log-invalid-steps',
            automation_id: 'automation-1',
            status: 'partial',
            error_message: null,
            steps_executed: { length: 1 },
            created_at: '2026-09-04T04:00:00.000Z',
          },
        ],
      },
    ],
    [
      'automation step status',
      {
        automationLogs: [
          {
            id: 'log-invalid-step-status',
            automation_id: 'automation-1',
            status: 'partial',
            error_message: null,
            steps_executed: [{ status: 'mystery', step_type: 'send_message' }],
            created_at: '2026-09-04T04:00:00.000Z',
          },
        ],
      },
    ],
    [
      'automation step detail',
      {
        automationLogs: [
          {
            id: 'log-invalid-step-detail',
            automation_id: 'automation-1',
            status: 'partial',
            error_message: null,
            steps_executed: [
              { status: 'failed', step_type: 'send_message', detail: 401 },
            ],
            created_at: '2026-09-04T04:00:00.000Z',
          },
        ],
      },
    ],
    [
      'pending execution status',
      {
        pendingExecutions: [
          {
            id: 'pending-invalid',
            automation_id: 'automation-1',
            status: 'running',
            run_at: '2026-09-04T04:00:00.000Z',
            created_at: '2026-09-04T03:59:00.000Z',
          },
        ],
      },
    ],
    [
      'flow run status',
      {
        flows: [{ id: 'flow-1', fallback_policy: {} }],
        flowRuns: [
          {
            id: 'flow-run-invalid',
            flow_id: 'flow-1',
            conversation_id: 'conversation-1',
            status: 'mystery',
            last_advanced_at: '2026-09-04T04:00:00.000Z',
            end_reason: null,
          },
        ],
      },
    ],
    [
      'flow run end reason',
      {
        flows: [{ id: 'flow-1', fallback_policy: {} }],
        flowRuns: [
          {
            id: 'flow-run-invalid-reason',
            flow_id: 'flow-1',
            conversation_id: 'conversation-1',
            status: 'failed',
            last_advanced_at: '2026-09-04T04:00:00.000Z',
            end_reason: { code: 'auth' },
          },
        ],
      },
    ],
    [
      'webhook boolean',
      {
        webhookEndpoints: [
          {
            id: 'webhook-invalid',
            is_active: 'false',
            failure_count: 0,
            last_delivery_at: null,
          },
        ],
      },
    ],
    [
      'webhook failure count',
      {
        webhookEndpoints: [
          {
            id: 'webhook-invalid-count',
            is_active: true,
            failure_count: '0',
            last_delivery_at: null,
          },
        ],
      },
    ],
    [
      'webhook last error',
      {
        webhookEndpoints: [
          {
            id: 'webhook-invalid-error',
            is_active: true,
            failure_count: 1,
            last_error: 401,
            last_delivery_at: '2026-09-04T04:00:00.000Z',
          },
        ],
      },
    ],
    [
      'WhatsApp registration error',
      {
        whatsappConfigs: [
          {
            id: 'whatsapp-invalid',
            status: 'connected',
            last_registration_error: 0,
          },
        ],
      },
    ],
  ])('fails closed on an invalid source %s', (_label, patch) => {
    expect(() =>
      buildAuditSnapshot({ ...baseData(), ...patch }, { nowMs: NOW })
    ).toThrow(/estado.*inválido/i);
  });

  it('fails closed on missing or duplicate source identifiers', () => {
    const missing = {
      ...baseData(),
      messages: [
        {
          conversation_id: 'conversation-1',
          sender_type: 'customer',
          content_type: 'text',
          content_text: '',
          status: 'delivered',
          created_at: '2026-09-04T04:00:00.000Z',
          ai_generated: false,
        },
      ],
    };
    const duplicate = {
      ...baseData(),
      contacts: [{ id: 'duplicate' }, { id: 'duplicate' }],
    };

    expect(() => buildAuditSnapshot(missing, { nowMs: NOW })).toThrow(
      /identificadores.*inválidos/i
    );
    expect(() => buildAuditSnapshot(duplicate, { nowMs: NOW })).toThrow(
      /identificadores.*inválidos/i
    );
  });

  it('fails closed on identifiers containing lone UTF-16 surrogates', () => {
    const data = baseData();
    data.conversations[0].id = String.fromCharCode(0xd800);

    expect(() => buildAuditSnapshot(data, { nowMs: NOW })).toThrow(
      /identificadores.*inválidos/i
    );
  });

  it.each([
    [
      'message conversation',
      {
        messages: [
          {
            id: 'message-without-conversation',
            sender_type: 'customer',
            content_type: 'text',
            content_text: '',
            status: 'delivered',
            created_at: '2026-09-04T04:00:00.000Z',
            ai_generated: false,
          },
        ],
      },
    ],
    [
      'automation log definition',
      {
        automationLogs: [
          {
            id: 'log-without-automation',
            status: 'failed',
            error_message: null,
            steps_executed: [],
            created_at: '2026-09-04T04:00:00.000Z',
          },
        ],
      },
    ],
    [
      'pending execution definition',
      {
        pendingExecutions: [
          {
            id: 'pending-without-automation',
            status: 'pending',
            run_at: '2026-09-04T04:00:00.000Z',
            created_at: '2026-09-04T03:59:00.000Z',
          },
        ],
      },
    ],
    [
      'flow run definition',
      {
        flowRuns: [
          {
            id: 'run-without-flow',
            conversation_id: null,
            status: 'active',
            last_advanced_at: '2026-09-04T04:00:00.000Z',
            end_reason: null,
          },
        ],
      },
    ],
  ])('fails closed on a missing %s identifier', (_label, patch) => {
    expect(() =>
      buildAuditSnapshot({ ...baseData(), ...patch }, { nowMs: NOW })
    ).toThrow(/identificadores.*inválidos/i);
  });

  it.each([
    [
      'message conversation',
      {
        messages: [
          {
            id: 'message-orphan',
            conversation_id: 'missing-conversation',
            sender_type: 'customer',
            content_type: 'text',
            content_text: '',
            status: 'delivered',
            created_at: '2026-09-04T04:00:00.000Z',
            ai_generated: false,
          },
        ],
      },
    ],
    [
      'flow-run flow',
      {
        flowRuns: [
          {
            id: 'flow-run-orphan',
            flow_id: 'missing-flow',
            conversation_id: null,
            status: 'active',
            last_advanced_at: '2026-09-04T04:00:00.000Z',
            end_reason: null,
          },
        ],
      },
    ],
  ])('fails closed on an unresolved %s relationship', (_label, patch) => {
    expect(() =>
      buildAuditSnapshot({ ...baseData(), ...patch }, { nowMs: NOW })
    ).toThrow(/relaciones.*inválidas/i);
  });

  it('is permutation-stable for canonically equivalent non-ASCII identifiers', () => {
    const messages = [
      {
        id: 'é',
        conversation_id: 'conversation-order',
        sender_type: 'customer',
        content_type: 'text',
        content_text: '¿Cuánto cuesta?',
        status: 'delivered',
        created_at: '2026-09-04T03:00:00.000Z',
        ai_generated: false,
      },
      {
        id: 'e\u0301',
        conversation_id: 'conversation-order',
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'Gracias',
        status: 'delivered',
        created_at: '2026-09-04T03:00:00.000Z',
        ai_generated: false,
      },
    ];
    const data = {
      ...baseData(),
      conversations: [
        {
          id: 'conversation-order',
          contact_id: 'contact-1',
          status: 'open',
          assigned_agent_id: null,
          ai_autoreply_disabled: false,
          ai_handoff_summary: null,
        },
      ],
      messages,
    };

    expect(buildAuditSnapshot(data, { nowMs: NOW })).toEqual(
      buildAuditSnapshot(
        { ...data, messages: [...messages].reverse() },
        { nowMs: NOW }
      )
    );
  });
});
