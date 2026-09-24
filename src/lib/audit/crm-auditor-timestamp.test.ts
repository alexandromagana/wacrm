import { describe, expect, it } from 'vitest';

import { buildAuditSnapshot as buildAuditSnapshotRaw } from './crm-auditor.mjs';

const OFFSET_TIMESTAMP = '2026-09-04T00:00:00.123456-05:00';
const CANONICAL_TIMESTAMP = '2026-09-04T05:00:00.123Z';

function buildAuditSnapshot(
  rawData: Record<string, Array<Record<string, unknown>>>,
  options: Record<string, unknown>
) {
  const complete: Record<string, Array<Record<string, unknown>>> = {
    contacts: [],
    conversations: [],
    messages: [],
    automationLogs: [],
    pendingExecutions: [],
    flows: [],
    flowRuns: [],
    webhookEndpoints: [],
    whatsappConfigs: [],
    ...rawData,
  };
  return buildAuditSnapshotRaw(
    {
      ...complete,
      conversations: complete.conversations.map((conversation) => ({
        contact_id: complete.contacts[0]?.id ?? 'contact-1',
        ai_autoreply_disabled: false,
        ...conversation,
      })),
      messages: complete.messages.map((message) => ({
        ai_generated: false,
        ...message,
      })),
      pendingExecutions: complete.pendingExecutions.map((pending) => ({
        created_at: pending.run_at,
        ...pending,
      })),
    },
    {
      referenceKey: 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo',
      ...options,
    }
  );
}

function collectTimestampValues(value: unknown): string[] {
  const timestamps: string[] = [];

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (
        typeof child === 'string' &&
        (key === 'at' || key === 'run_at' || key.endsWith('_at'))
      ) {
        timestamps.push(child);
      }
      visit(child);
    }
  }

  visit(value);
  return timestamps;
}

describe('audit timestamp wire format', () => {
  it('normalises every emitted timestamp to millisecond UTC ISO', () => {
    const snapshot = buildAuditSnapshot(
      {
        contacts: [{ id: 'contact-1' }],
        conversations: [
          {
            id: 'conversation-1',
            contact_id: 'contact-1',
            status: 'open',
            assigned_to: null,
            ai_autoreply_disabled: false,
            ai_handoff_summary: null,
          },
        ],
        messages: [
          {
            id: 'message-1',
            conversation_id: 'conversation-1',
            sender_type: 'customer',
            content_type: 'text',
            content_text: '¿Cuánto cuesta?',
            status: 'delivered',
            ai_generated: false,
            created_at: OFFSET_TIMESTAMP,
          },
          {
            id: 'message-2',
            conversation_id: 'conversation-1',
            sender_type: 'agent',
            content_type: 'text',
            content_text: 'Respuesta',
            status: 'failed',
            status_error: 'timeout',
            ai_generated: false,
            created_at: OFFSET_TIMESTAMP,
          },
        ],
        automationLogs: [
          {
            id: 'log-1',
            automation_id: 'automation-1',
            status: 'failed',
            error_message: 'timeout',
            steps_executed: [{ status: 'failed', step_type: 'send_message' }],
            created_at: OFFSET_TIMESTAMP,
          },
        ],
        pendingExecutions: [
          {
            id: 'pending-1',
            automation_id: 'automation-1',
            status: 'pending',
            run_at: OFFSET_TIMESTAMP,
          },
        ],
        flows: [],
        flowRuns: [],
        webhookEndpoints: [
          {
            id: 'webhook-1',
            is_active: false,
            failure_count: 1,
            last_delivery_at: OFFSET_TIMESTAMP,
          },
        ],
        whatsappConfigs: [],
      },
      { nowMs: Date.parse('2026-09-04T06:00:00.000Z') }
    );

    const timestamps = collectTimestampValues(snapshot);
    expect(timestamps.length).toBeGreaterThan(0);
    expect(timestamps).toEqual(
      Array.from({ length: timestamps.length }, () => CANONICAL_TIMESTAMP)
    );
  });

  it('rejects permissive Date.parse strings that can carry free text', () => {
    const unsafeTimestamp =
      'Fri, 04 Sep 2026 04:00:00 GMT (Customer customer@example.com)';
    expect(() =>
      buildAuditSnapshot(
        {
          contacts: [{ id: 'contact-1' }],
          conversations: [
            {
              id: 'conversation-1',
              status: 'open',
              assigned_to: null,
              ai_autoreply_disabled: false,
              ai_handoff_summary: null,
            },
          ],
          messages: [
            {
              id: 'message-1',
              conversation_id: 'conversation-1',
              sender_type: 'customer',
              content_type: 'text',
              content_text: 'Pregunta',
              status: 'delivered',
              ai_generated: false,
              created_at: unsafeTimestamp,
            },
          ],
        },
        { nowMs: Date.parse('2026-09-04T06:00:00.000Z') }
      )
    ).toThrow(/fecha inválida/i);
  });

  it('fails closed on an impossible source calendar date', () => {
    expect(() =>
      buildAuditSnapshot(
        {
          contacts: [{ id: 'contact-1' }],
          conversations: [
            {
              id: 'conversation-1',
              status: 'open',
              assigned_to: null,
              ai_autoreply_disabled: false,
              ai_handoff_summary: null,
            },
          ],
          messages: [
            {
              id: 'message-1',
              conversation_id: 'conversation-1',
              sender_type: 'customer',
              content_type: 'text',
              content_text: 'Pregunta',
              status: 'delivered',
              ai_generated: false,
              created_at: '2026-02-30T12:00:00.000Z',
            },
          ],
        },
        { nowMs: Date.parse('2026-09-04T06:00:00.000Z') }
      )
    ).toThrow(/fecha inválida/i);
  });

  it('fails closed when UTC normalisation crosses the four-digit year boundary', () => {
    expect(() =>
      buildAuditSnapshot(
        {
          contacts: [{ id: 'contact-1' }],
          conversations: [
            {
              id: 'conversation-1',
              status: 'open',
              assigned_to: null,
              ai_autoreply_disabled: false,
              ai_handoff_summary: null,
            },
          ],
          messages: [
            {
              id: 'message-1',
              conversation_id: 'conversation-1',
              sender_type: 'customer',
              content_type: 'text',
              content_text: 'Pregunta',
              status: 'delivered',
              ai_generated: false,
              created_at: '0001-01-01T00:00:00.000+01:00',
            },
          ],
        },
        { nowMs: Date.parse('2026-09-04T06:00:00.000Z') }
      )
    ).toThrow(/fecha inválida/i);
  });

  it('fails closed when a required source timestamp is missing', () => {
    expect(() =>
      buildAuditSnapshot(
        {
          contacts: [{ id: 'contact-1' }],
          conversations: [
            {
              id: 'conversation-1',
              status: 'open',
              assigned_to: null,
              ai_autoreply_disabled: false,
              ai_handoff_summary: null,
            },
          ],
          messages: [
            {
              id: 'message-1',
              conversation_id: 'conversation-1',
              sender_type: 'customer',
              content_type: 'text',
              content_text: 'Pregunta',
              status: 'delivered',
              ai_generated: false,
              created_at: null,
            },
          ],
        },
        { nowMs: Date.parse('2026-09-04T06:00:00.000Z') }
      )
    ).toThrow(/fecha inválida/i);
  });

  it.each([
    'nowMs',
    'responseSlaMinutes',
    'staleSentMinutes',
    'pendingGraceMinutes',
    'incidentLookbackDays',
  ])('rejects the explicit null temporal option %s', (key) => {
    const options: Record<string, unknown> = {
      nowMs: Date.parse('2026-09-04T06:00:00.000Z'),
      [key]: null,
    };

    expect(() => buildAuditSnapshot({}, options)).toThrow(
      /opciones temporales inválidas/i
    );
  });
});
