/**
 * Lifecycle sweep settings — when a silent prospect gets a reminder,
 * when it gets closed, and how much one run may do.
 *
 * The timings match the follow-up automations that already run off the
 * "Quote sent" tag (scripts/setup-automations.mjs): `seguimiento_coti`
 * 48h after the proposal, `sin_respuesta` at day 5. A quoted prospect
 * closes 3 days after that second follow-up; a lead that never sent
 * their bill gets one reminder after 3 quiet days and closes 4 days
 * later.
 */

export type SweepMode = 'off' | 'dry_run' | 'apply'

export interface LifecycleConfig {
  /** Quoted: days of silence since the later of the last customer message and the quote. */
  quotedSilenceDays: number
  /** Quoted: days after the last follow-up template before closing. */
  afterFollowUpDays: number
  /** Not quoted: days of silence before the receipt reminder. */
  remindAfterDays: number
  /** Not quoted: days after the reminder before closing. */
  closeAfterReminderDays: number
  /**
   * Silent longer than this and never reminded: close without sending
   * anything. A marketing template to someone quiet for months mostly
   * earns blocks, and blocks cost the number its quality rating.
   */
  directCloseAfterDays: number
  /** Chats a person owns, or that fit no rule: suggest closing after this. */
  suggestAfterDays: number
  followUpTemplates: readonly string[]
  reminderTemplate: { name: string; language: string }
  /** Contacts with this tag are never touched. Matched case-insensitively. */
  exemptTagName: string
  businessHours: {
    timeZone: string
    /** Inclusive, 0–23. */
    startHour: number
    /** Exclusive, 0–23. */
    endHour: number
    /** 0 = Sunday … 6 = Saturday. */
    days: readonly number[]
  }
  caps: { reminders: number; closes: number }
  /** A `running` automation row older than this is treated as stuck. */
  staleRunningHours: number
  /** One cron run per window of this many minutes. */
  runIntervalMinutes: number
}

export const LIFECYCLE_CONFIG: LifecycleConfig = {
  quotedSilenceDays: 8,
  afterFollowUpDays: 3,
  remindAfterDays: 3,
  closeAfterReminderDays: 4,
  directCloseAfterDays: 45,
  suggestAfterDays: 7,
  followUpTemplates: ['seguimiento_coti', 'sin_respuesta'],
  reminderTemplate: { name: 'gama_seguimiento_lead', language: 'es_MX' },
  exemptTagName: 'No cerrar',
  businessHours: {
    timeZone: 'America/Mexico_City',
    startHour: 9,
    endHour: 19,
    days: [1, 2, 3, 4, 5, 6],
  },
  caps: { reminders: 15, closes: 50 },
  staleRunningHours: 2,
  runIntervalMinutes: 30,
}

/**
 * `LIFECYCLE_SWEEP=off|dry_run|apply`. Off unless set: the sweep sends
 * WhatsApp messages and closes chats, so it only runs once someone
 * turns it on.
 */
export function getSweepMode(env: Record<string, string | undefined> = process.env): SweepMode {
  const raw = env.LIFECYCLE_SWEEP?.trim().toLowerCase()
  return raw === 'dry_run' || raw === 'apply' ? raw : 'off'
}
