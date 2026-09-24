import { describe, expect, it } from 'vitest';
import {
  buildAuditSnapshot as buildAuditSnapshotRaw,
  shortRef as shortRefRaw,
} from './crm-auditor.mjs';

const NOW = Date.parse('2026-09-04T05:00:00.000Z');
const REFERENCE_KEY = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo';
const shortRef = (value: unknown) => shortRefRaw(value, REFERENCE_KEY);
const buildAuditSnapshot = (
  rawData: Record<string, unknown>,
  options: Record<string, unknown> = {}
) =>
  buildAuditSnapshotRaw(rawData, {
    referenceKey: REFERENCE_KEY,
    ...options,
  });
const AT = '2026-09-04T03:00:00.000Z';
type Row = Record<string, unknown>;
function fixture(patch: Record<string, Row[]> = {}) {
  return {
    contacts: [],
    conversations: [
      {
        id: 'conversation',
        status: 'open',
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
    ...patch,
  };
}
function message(patch: Row = {}) {
  return {
    id: 'message',
    conversation_id: 'conversation',
    sender_type: 'customer',
    content_type: 'text',
    content_text: '¿Me ayudan?',
    status: 'delivered',
    ai_generated: false,
    created_at: AT,
    ...patch,
  };
}
function snapshot(patch: Record<string, Row[]> = {}, options: Row = {}) {
  return buildAuditSnapshot(fixture(patch), { nowMs: NOW, ...options });
}

describe('CRM auditor logic regressions', () => {
  it('counts every distinct failed automation step and ignores blank top-level errors', () => {
    const steps = [
      { step_type: 'send_message', status: 'failed', detail: 'timeout' },
      { step_type: 'send_webhook', status: 'failed', detail: 'network' },
    ];
    const log = {
      id: 'log',
      automation_id: 'auto',
      status: 'partial',
      error_message: ' \t ',
      created_at: AT,
      steps_executed: steps,
    };
    const result = snapshot({ automationLogs: [log] });
    expect(result.omitted.automation_failures).toBe(1);
    expect(['timeout', 'network']).toContain(
      result.technical.automation_failures[0].error_code
    );
    expect(result).toEqual(
      snapshot({
        automationLogs: [{ ...log, steps_executed: [...steps].reverse() }],
      })
    );
  });
  it('counts an automation log once per distinct failure class', () => {
    const step = {
      step_type: 'send_message',
      status: 'failed',
      detail: 'timeout',
    };
    const result = snapshot({
      automationLogs: [
        {
          id: 'log',
          automation_id: 'auto',
          status: 'partial',
          created_at: AT,
          steps_executed: [step, { ...step }],
        },
      ],
    });
    expect(result.technical.automation_failures[0].occurrences).toBe(1);
    expect(result.omitted.automation_failures).toBe(0);
  });
  it.each([
    ['customer', 'sending'],
    ['customer', 'sent'],
    ['customer', 'failed'],
    ['agent', 'received'],
    ['bot', 'received'],
  ])(
    'rejects incompatible sender/status %s/%s rather than losing an incident',
    (sender_type, status) => {
      expect(() =>
        snapshot({ messages: [message({ sender_type, status })] })
      ).toThrow(/estado.*inválido/i);
    }
  );
  it.each([null, false, 1, {}, [], ''])(
    'rejects malformed content_type %j',
    (content_type) => {
      expect(() => snapshot({ messages: [message({ content_type })] })).toThrow(
        /estado.*inválido/i
      );
    }
  );
  it('bounds source text before classification', () => {
    expect(() =>
      snapshot({ messages: [message({ content_text: 'x'.repeat(65_537) })] })
    ).toThrow(/cobertura desconocida/i);
  });
  it.each(['last_registration_error', 'unused_source_field'])(
    'bounds source field %s before filtering or ignoring it',
    (field) => {
      expect(() =>
        snapshot({
          whatsappConfigs: [
            { id: 'wa', status: 'connected', [field]: 'x'.repeat(65_537) },
          ],
        })
      ).toThrow(/cobertura desconocida/i);
    }
  );
  it('bounds collections before deriving metrics', () => {
    expect(() =>
      snapshot({
        contacts: Array.from({ length: 20_001 }, (_, i) => ({ id: `c${i}` })),
      })
    ).toThrow(/cobertura desconocida/i);
  });
  it.each([false, 7, {}, []])(
    'rejects malformed automation step type %j',
    (step_type) => {
      expect(() =>
        snapshot({
          automationLogs: [
            {
              id: 'log',
              automation_id: 'auto',
              status: 'partial',
              created_at: AT,
              steps_executed: [
                { status: 'failed', step_type, detail: 'timeout' },
              ],
            },
          ],
        })
      ).toThrow(/estado.*inválido/i);
    }
  );
  it('rejects invalid WhatsApp status rather than mapping it to a healthy state', () => {
    expect(() =>
      snapshot({ whatsappConfigs: [{ id: 'wa', status: 'CONNECTED' }] })
    ).toThrow(/estado.*inválido/i);
  });
  it.each(Array.from({ length: 32 }, (_, index) => 0x80 + index))(
    'rejects C1 control %i in identifiers',
    (code) => {
      expect(() =>
        snapshot({ contacts: [{ id: `id${String.fromCharCode(code)}x` }] })
      ).toThrow(/identificadores.*inválidos/i);
    }
  );
  it.each(['No me contacten; tengo una queja', 'STOP, pésimo servicio'])(
    'prioritizes no-outreach without letting a complaint poison the audit: %s',
    (content_text) => {
      const result = snapshot({ messages: [message({ content_text })] });
      expect(result.customer_review.awaiting_response).toEqual([]);
      expect(
        result.customer_review.recent_interactions[0].recent_messages[0].signal
      ).toBe('do_not_contact');
    }
  );
  it('recognizes an explicit no-contact request with a complement clause', () => {
    const result = snapshot({
      messages: [
        message({
          content_text: 'No quiero que me contacten para ofrecerme paneles',
        }),
      ],
    });
    expect(
      result.customer_review.recent_interactions[0].recent_messages[0].signal
    ).toBe('do_not_contact');
  });
  it.each(['Contesté el cuestionario', 'Recibo sus mensajes'])(
    'does not classify an unrestricted commercial prefix as intent: %s',
    (content_text) => {
      const result = snapshot({ messages: [message({ content_text })] });
      expect(result.customer_review.awaiting_response[0].customer_signal).toBe(
        'other'
      );
    }
  );
  it('classifies a long punctuation suffix in linear time', () => {
    const result = snapshot({
      messages: [message({ content_text: `ok${','.repeat(30)}X` })],
    });
    expect(result.customer_review.awaiting_response[0].customer_signal).toBe(
      'other'
    );
  });
  it.each([
    ['Gracias, todo listo.', 'closure'],
    ['No me contacten de nuevo', 'do_not_contact'],
    ['   ', 'empty'],
  ])(
    'keeps an unresolved AI handoff visible for a %s customer signal',
    (content_text, customer_signal) => {
      const result = snapshot({
        conversations: [
          {
            ...fixture().conversations[0],
            ai_handoff_summary: 'pending handoff',
          },
        ],
        messages: [message({ content_text })],
      });
      expect(result.customer_review.awaiting_response[0]).toMatchObject({
        ai_handoff: true,
        customer_signal,
      });
    }
  );
  it('uses exact waiting age before opaque reference order within a bucket', () => {
    const olderConversation = 'conversation-0';
    const newerConversation = 'conversation-1';
    const result = snapshot(
      {
        conversations: [
          {
            ...fixture().conversations[0],
            id: newerConversation,
          },
          {
            ...fixture().conversations[0],
            id: olderConversation,
          },
        ],
        messages: [
          message({
            id: 'newer-message',
            conversation_id: newerConversation,
            content_text: 'Mensaje general',
            created_at: '2026-09-04T02:59:59.999999999Z',
          }),
          message({
            id: 'older-message',
            conversation_id: olderConversation,
            content_text: 'Pésimo servicio',
            created_at: '2026-09-03T06:00:00.000000001Z',
          }),
        ],
      }
    );
    expect(result.customer_review.awaiting_response[0].conversation_ref).toBe(
      shortRef(olderConversation)
    );
  });
  it('prioritizes an explicit failed Flow over a stalled Flow before capping', () => {
    const result = snapshot(
      {
        flows: [
          { id: 'flow-failed', fallback_policy: {} },
          { id: 'flow-stalled', fallback_policy: { on_timeout_hours: 1 } },
        ],
        flowRuns: [
          {
            id: 'run-0',
            flow_id: 'flow-stalled',
            conversation_id: null,
            status: 'active',
            last_advanced_at: '2026-09-03T05:00:00.000Z',
            end_reason: null,
          },
          {
            id: 'run-1',
            flow_id: 'flow-failed',
            conversation_id: null,
            status: 'failed',
            last_advanced_at: '2026-09-04T04:59:00.000Z',
            end_reason: 'timeout',
          },
        ],
      },
      { maxTechnicalPerCategory: 1 }
    );
    expect(result.technical.flow_incidents[0].incident_key).toBe(
      `flow-failed:${shortRef('run-1')}`
    );
  });
  it('prioritizes the oldest stalled Flow before opaque reference order', () => {
    const result = snapshot(
      {
        flows: [{ id: 'flow', fallback_policy: { on_timeout_hours: 1 } }],
        flowRuns: [
          {
            id: 'run-0',
            flow_id: 'flow',
            conversation_id: null,
            status: 'active',
            last_advanced_at: '2026-09-04T03:00:00.000Z',
            end_reason: null,
          },
          {
            id: 'run-1',
            flow_id: 'flow',
            conversation_id: null,
            status: 'active',
            last_advanced_at: '2026-09-03T05:00:00.000Z',
            end_reason: null,
          },
        ],
      },
      { maxTechnicalPerCategory: 1 }
    );
    expect(result.technical.flow_incidents[0].incident_key).toBe(
      `flow-stalled:${shortRef('run-1')}`
    );
  });
  it.each(['', ' ', '\t\n', '\u00a0'])(
    'fails closed on a blank handoff marker %j',
    (summary) => {
      const conversations = [
        { ...fixture().conversations[0], ai_handoff_summary: summary },
      ];
      expect(() => snapshot({ conversations })).toThrow(/estado.*inválido/i);
    }
  );
  it('resolves a reply one nanosecond after the customer in the same millisecond', () => {
    const result = snapshot({
      messages: [
        message({
          id: 'z-customer',
          created_at: '2026-09-04T03:00:00.123456788Z',
        }),
        message({
          id: 'a-reply',
          sender_type: 'agent',
          created_at: '2026-09-04T03:00:00.123456789Z',
        }),
      ],
    });
    expect(result.customer_review.awaiting_response).toEqual([]);
    expect(result.customer_review.recent_interactions[0].latest_sender).toBe(
      'agent'
    );
  });
  it('selects the latest customer by full source precision, not identifier order', () => {
    const messages = [
      message({
        id: 'z-question',
        created_at: '2026-09-04T03:00:00.000000001Z',
      }),
      message({
        id: 'a-closure',
        content_text: 'Gracias',
        created_at: '2026-09-04T03:00:00.000000002Z',
      }),
    ];
    expect(snapshot({ messages }).customer_review.awaiting_response).toEqual(
      []
    );
    expect(snapshot({ messages })).toEqual(
      snapshot({ messages: [...messages].reverse() })
    );
  });
  it.each(['failed', 'sent'])(
    'prioritises %s incidents before millisecond wire rounding',
    (status) => {
      const ids = ['a', 'b'].sort((a, b) =>
        shortRef(a) < shortRef(b) ? -1 : 1
      );
      const messages = ids.map((id, index) =>
        message({
          id,
          sender_type: 'agent',
          status,
          created_at: `2026-09-04T02:00:00.00000000${status === 'failed' ? index + 1 : 2 - index}Z`,
        })
      );
      const result = snapshot({ messages });
      const rows =
        status === 'failed'
          ? result.technical.failed_messages
          : result.technical.stale_sent_messages;
      expect(rows[0].incident_key).toBe(
        `message-${status === 'failed' ? 'failed' : 'stale'}:${shortRef(ids[1])}`
      );
    }
  );
  it('prioritises recent conversations before millisecond wire rounding', () => {
    const ids = ['a', 'b'].sort((a, b) => (shortRef(a) < shortRef(b) ? -1 : 1));
    const conversations = ids.map((id) => ({
      ...fixture().conversations[0],
      id,
    }));
    const messages = ids.map((id, index) =>
      message({
        id,
        conversation_id: id,
        sender_type: 'agent',
        created_at: `2026-09-04T03:00:00.00000000${index + 1}Z`,
      })
    );
    expect(
      snapshot({ conversations, messages }).customer_review
        .recent_interactions[0].conversation_ref
    ).toBe(shortRef(ids[1]));
  });
  it('does not cross the response SLA or age bucket one nanosecond early', () => {
    const result = snapshot({
      messages: [
        message({ created_at: '2026-09-04T04:30:00.000000001Z' }),
        message({
          id: 'failed-message',
          sender_type: 'agent',
          status: 'failed',
          created_at: '2026-09-04T04:30:00.000000001Z',
        }),
      ],
    });
    expect(result.customer_review.awaiting_response).toEqual([]);
    expect(result.technical.failed_messages[0].age_bucket).toBe('<30m');
  });
  it('does not mark a sent message stale one nanosecond early', () => {
    const result = snapshot({
      messages: [
        message({
          sender_type: 'agent',
          status: 'sent',
          created_at: '2026-09-04T03:00:00.000000001Z',
        }),
      ],
    });
    expect(result.technical.stale_sent_messages).toEqual([]);
  });
  it('does not mark a pending execution overdue one nanosecond early', () => {
    const result = snapshot({
      pendingExecutions: [
        {
          id: 'pending',
          automation_id: 'automation',
          status: 'pending',
          created_at: '2026-09-04T04:45:00.000000001Z',
          run_at: '2026-09-04T04:45:00.000000001Z',
        },
      ],
    });
    expect(result.technical.overdue_automation_executions).toEqual([]);
  });
  it('does not mark an active Flow stalled one nanosecond early', () => {
    const result = snapshot({
      flows: [{ id: 'flow', fallback_policy: { on_timeout_hours: 1 } }],
      flowRuns: [
        {
          id: 'run',
          flow_id: 'flow',
          conversation_id: null,
          status: 'active',
          last_advanced_at: '2026-09-04T03:45:00.000000001Z',
          end_reason: null,
        },
      ],
    });
    expect(result.technical.flow_incidents).toEqual([]);
  });
  it('ignores a whitespace-only WhatsApp registration error', () => {
    const result = snapshot({
      whatsappConfigs: [
        { id: 'wa', status: 'connected', last_registration_error: ' \t ' },
      ],
    });
    expect(result.technical.whatsapp_incidents).toEqual([]);
  });
  it.each(['0001', '000001', '000000001'])(
    'rejects future fractional instant .%s',
    (fraction) => {
      expect(() =>
        snapshot({
          messages: [
            message({ created_at: `2026-09-04T05:00:00.${fraction}Z` }),
          ],
        })
      ).toThrow(/timestamp.*futuro/i);
    }
  );
});
