import { describe, it, expect } from 'vitest'
import { buildQuoteMergeFields, QUOTE_MERGE_TAGS } from './merge-fields'
import { buildQuoteFieldValues } from './fields'
import { SOLAR_TIERS } from './pricing'
import { buildFinancials } from './finance'

const TIER = SOLAR_TIERS.find((t) => t.panels === 14)!
const NOW = new Date('2026-08-18T12:00:00Z')
const FINANCIALS = buildFinancials({
  costoBimestralMxn: 10_237.85,
  tier: TIER,
})

const input = {
  nombre: 'María Fernanda Villaseñor',
  tier: TIER,
  folio: 'GE-2026-X2H6',
  now: NOW,
  financials: FINANCIALS,
  tipoProyecto: 'Residencial',
  ciudad: 'Cancún',
  consumoKwh: 2_100,
}

describe('buildQuoteMergeFields', () => {
  it('fills every tag it advertises', () => {
    const fields = buildQuoteMergeFields(input)
    for (const tag of QUOTE_MERGE_TAGS) {
      expect(fields[tag], `missing tag: ${tag}`).toBeDefined()
    }
  })

  // The whole point of composing over buildQuoteFieldValues: a peso
  // formatted one way on the bot's PDF and another on a manual quote is
  // what a customer holding both would notice.
  it('reproduces the PDF fields byte for byte', () => {
    const pdfFields = buildQuoteFieldValues(input)
    const mergeFields = buildQuoteMergeFields(input)
    for (const [key, value] of Object.entries(pdfFields)) {
      expect(mergeFields[key as keyof typeof mergeFields]).toBe(value)
    }
  })

  it('formats the extra tags the PDF does not carry', () => {
    const fields = buildQuoteMergeFields(input)
    expect(fields.tipoProyecto).toBe('Residencial')
    expect(fields.ciudad).toBe('Cancún')
    expect(fields.consumoKwh).toBe('2,100 kWh')
  })

  // Blank, never the literal "null" or "undefined" — a template that
  // references a tag we can't fill should read as incomplete, not broken.
  it('blanks the optional tags rather than printing null', () => {
    const fields = buildQuoteMergeFields({
      ...input,
      ciudad: null,
      consumoKwh: null,
    })
    expect(fields.ciudad).toBe('')
    expect(fields.consumoKwh).toBe('')
  })

  it('blanks the financial tags when the bill was unreadable', () => {
    const fields = buildQuoteMergeFields({ ...input, financials: null })
    expect(fields.ahorro25Anios).toBe('')
    expect(fields.payback).toBe('')
    // The system itself is still known — only the projection is missing.
    expect(fields.precio).toBe('$ 127,000')
    expect(fields.paneles).toBe('14')
  })

  it('sanitises the project type like every other drawn string', () => {
    const fields = buildQuoteMergeFields({
      ...input,
      tipoProyecto: '  Comercial  “PDBT”  ',
    })
    expect(fields.tipoProyecto).toBe('Comercial "PDBT"')
  })
})
