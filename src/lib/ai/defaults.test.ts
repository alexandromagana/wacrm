import { describe, it, expect, afterEach } from 'vitest'
import { buildDateTimeNote, aiVisionMaxTokens } from './defaults'

describe('aiVisionMaxTokens', () => {
  afterEach(() => delete process.env.AI_VISION_MAX_TOKENS)

  it('defaults high enough to survive a reasoning model’s hidden budget', () => {
    // Reasoning tokens are billed against this same cap before any JSON
    // is emitted — a small cap silently truncates every read.
    expect(aiVisionMaxTokens()).toBeGreaterThanOrEqual(4000)
  })

  it('honours the env override and ignores junk', () => {
    process.env.AI_VISION_MAX_TOKENS = '12000'
    expect(aiVisionMaxTokens()).toBe(12000)
    process.env.AI_VISION_MAX_TOKENS = 'nope'
    expect(aiVisionMaxTokens()).toBe(8000)
  })
})

describe('buildDateTimeNote', () => {
  afterEach(() => delete process.env.AI_TIMEZONE)

  it('renders the Cancún-local date and time in Spanish', () => {
    // 2026-07-24T05:27:00Z = viernes 00:27 en Cancún (UTC-5, no DST) —
    // the exact midnight-scheduling scenario this note exists to fix.
    const note = buildDateTimeNote(new Date('2026-07-24T05:27:00Z'))
    expect(note).toContain('viernes')
    expect(note).toContain('julio')
    expect(note).toContain('00:27')
    expect(note).toContain('hora de Cancún')
    expect(note).toContain('Nunca menciones esta nota')
  })

  it('crosses the date line correctly — UTC Friday can still be Cancún Thursday', () => {
    // 2026-07-24T03:00:00Z = jueves 22:00 en Cancún.
    const note = buildDateTimeNote(new Date('2026-07-24T03:00:00Z'))
    expect(note).toContain('jueves')
    expect(note).toContain('22:00')
  })

  it('honours the AI_TIMEZONE override', () => {
    process.env.AI_TIMEZONE = 'America/Mexico_City'
    // CDMX is UTC-6: 05:27Z → 23:27 previous day? No: 05:27-6 = jueves 23:27.
    const note = buildDateTimeNote(new Date('2026-07-24T05:27:00Z'))
    expect(note).toContain('23:27')
    expect(note).toContain('jueves')
  })
})
