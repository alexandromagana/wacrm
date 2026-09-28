import { describe, expect, it } from 'vitest';

import { collectAuditSnapshot } from '../../../scripts/audit-crm.mjs';

const READ_STARTED_MS = Date.parse('2026-09-26T12:00:00.000Z');
const READ_FINISHED_MS = READ_STARTED_MS + 1_500;
const CONFIG = {
  CRM_AUDIT_SUPABASE_URL: 'https://project.supabase.co',
  CRM_AUDIT_API_KEY: 'synthetic-anon-key',
  CRM_AUDIT_ACCESS_TOKEN: 'synthetic-audit-token',
  CRM_AUDIT_ACCOUNT_ID: '123e4567-e89b-42d3-a456-426614174000',
  CRM_AUDIT_REFERENCE_KEY: Buffer.alloc(32, 7).toString('base64url'),
};

function sourceWithLastMessageAt(lastMessageAt: string) {
  return {
    contacts: [{ id: 'contact-1' }],
    conversations: [
      {
        id: 'conversation-1',
        contact_id: 'contact-1',
        status: 'open',
        assigned_agent_id: null,
        ai_autoreply_disabled: false,
        ai_handoff_summary: null,
        last_message_at: lastMessageAt,
      },
    ],
    messages: [],
    automations: [],
    automationLogs: [],
    pendingExecutions: [],
    flows: [],
    flowRuns: [],
    webhookEndpoints: [],
    whatsappConfigs: [
      { id: 'whatsapp-1', status: 'connected', last_registration_error: null },
    ],
  };
}

// Two readings: when the reads start, then when the last page has arrived.
function clockReading(...readings: number[]) {
  return () => {
    const next = readings.shift();
    if (next === undefined) throw new Error('clock read too often');
    return next;
  };
}

describe('collectAuditSnapshot', () => {
  it('bounds the reads by the moment they start', async () => {
    let requestedNowMs: number | undefined;
    await collectAuditSnapshot({
      config: CONFIG,
      clock: clockReading(READ_STARTED_MS, READ_FINISHED_MS),
      readData: async (options: { nowMs: number }) => {
        requestedNowMs = options.nowMs;
        return sourceWithLastMessageAt('2026-09-26T11:59:00.000Z');
      },
    });
    expect(requestedNowMs).toBe(READ_STARTED_MS);
  });

  it('accepts a conversation that moved while the pages were read', async () => {
    const output = await collectAuditSnapshot({
      config: CONFIG,
      clock: clockReading(READ_STARTED_MS, READ_FINISHED_MS),
      readData: async () =>
        sourceWithLastMessageAt(new Date(READ_STARTED_MS + 700).toISOString()),
    });
    expect(JSON.parse(output).schema_version).toBe(2);
  });

  it('still rejects a timestamp later than the end of the read', async () => {
    await expect(
      collectAuditSnapshot({
        config: CONFIG,
        clock: clockReading(READ_STARTED_MS, READ_FINISHED_MS),
        readData: async () =>
          sourceWithLastMessageAt(new Date(READ_FINISHED_MS + 1).toISOString()),
      })
    ).rejects.toThrow('timestamp futuro');
  });
});
