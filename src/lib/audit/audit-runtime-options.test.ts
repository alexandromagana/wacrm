import { describe, expect, it } from 'vitest';
import { parseAuditOptions } from './audit-runtime-options.mjs';

describe('audit temporal coverage contract', () => {
  it('defaults only absent settings and fixes wire output caps', () => {
    expect(parseAuditOptions({})).toEqual({
      historyDays: 90,
      incidentLookbackDays: 30,
      responseSlaMinutes: 30,
      staleSentMinutes: 120,
      pendingGraceMinutes: 15,
      maxAwaitingConversations: 3,
      maxRecentConversations: 1,
      maxTechnicalIncidents: 1,
      messagesPerConversation: 1,
    });
  });
  it.each(['', 'no', '1.5', ' 30', 'NaN'])(
    'rejects invalid values %s',
    (value) => {
      expect(() =>
        parseAuditOptions({ CRM_AUDIT_HISTORY_DAYS: value })
      ).toThrow();
    }
  );
  it('requires overlap beyond incident coverage instead of silently expanding history', () => {
    expect(() => parseAuditOptions({ CRM_AUDIT_HISTORY_DAYS: '30' })).toThrow(
      /cobertura/i
    );
  });
  it('requires one cadence beyond the response SLA', () => {
    const config = {
      CRM_AUDIT_HISTORY_DAYS: '2',
      CRM_AUDIT_INCIDENT_LOOKBACK_DAYS: '1',
    };
    expect(() =>
      parseAuditOptions({
        ...config,
        CRM_AUDIT_RESPONSE_SLA_MINUTES: String(2 * 1440 - 30),
      })
    ).not.toThrow();
    expect(() =>
      parseAuditOptions({
        ...config,
        CRM_AUDIT_RESPONSE_SLA_MINUTES: String(2 * 1440 - 29),
      })
    ).toThrow(/cobertura/i);
  });
  it('requires one cadence beyond stale-sent threshold', () => {
    const config = { CRM_AUDIT_INCIDENT_LOOKBACK_DAYS: '1' };
    expect(() =>
      parseAuditOptions({
        ...config,
        CRM_AUDIT_STALE_SENT_MINUTES: String(1440 - 30),
      })
    ).not.toThrow();
    expect(() =>
      parseAuditOptions({
        ...config,
        CRM_AUDIT_STALE_SENT_MINUTES: String(1440 - 29),
      })
    ).toThrow(/cobertura/i);
  });
  it('rejects output cap overrides even from direct callers', () => {
    expect(() =>
      parseAuditOptions({ CRM_AUDIT_AWAITING_CONVERSATIONS: '1' })
    ).toThrow();
  });
});
