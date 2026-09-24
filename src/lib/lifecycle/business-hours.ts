import type { LifecycleConfig } from './config'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Whether `now` falls inside business hours in the configured zone.
 * Reminders are only sent then; closing needs no message, so it runs
 * any time.
 */
export function isBusinessHours(now: Date, hours: LifecycleConfig['businessHours']): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: hours.timeZone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now)
  const weekday = WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '')
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  if (weekday < 0 || Number.isNaN(hour)) return false
  return hours.days.includes(weekday) && hour >= hours.startHour && hour < hours.endHour
}
