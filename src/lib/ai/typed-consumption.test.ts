import { describe, it, expect } from 'vitest'
import {
  customerTurnText,
  mentionsTypedConsumption,
  TYPED_CONSUMPTION_NOTE,
} from './typed-consumption'

describe('mentionsTypedConsumption', () => {
  it('catches the message that started this', () => {
    expect(mentionsTypedConsumption('Gaste 1674 kw en el último recibo')).toBe(true)
  })

  it('reads the unit however customers spell it', () => {
    for (const text of [
      'mi consumo es 1,400 kWh',
      'gasto 900kwh',
      'fueron 1.250 kw/h',
      'como 850 kws al bimestre',
      '1500 kilowatts',
      '1500 kilowats hora',
      '1200 kilovatios',
      'kWh: 1674',
      'en kw fueron 2,100',
    ]) {
      expect(mentionsTypedConsumption(text), text).toBe(true)
    }
  })

  it('leaves a system size alone', () => {
    // "10 kW" is a question about the system, not a consumption.
    expect(mentionsTypedConsumption('¿cuánto cuesta un sistema de 10 kW?')).toBe(false)
    expect(mentionsTypedConsumption('quiero algo de 7.5 kw')).toBe(false)
  })

  it('leaves money and plain numbers alone', () => {
    expect(mentionsTypedConsumption('pago como 5000 de luz')).toBe(false)
    expect(mentionsTypedConsumption('¿Cuánto pagas?: De $2000 a $5000')).toBe(false)
    expect(mentionsTypedConsumption('mi número es 9981581891')).toBe(false)
  })

  it('does not find a unit inside another word', () => {
    expect(mentionsTypedConsumption('lo vi en Kwai 2024')).toBe(false)
  })
})

describe('customerTurnText', () => {
  it('joins everything the customer said since the last reply', () => {
    expect(
      customerTurnText([
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: '¿Me mandas tu recibo?' },
        { role: 'user', content: 'gasté 1674 kw' },
        { role: 'user', content: '¿cuánto sería?' },
      ]),
    ).toBe('gasté 1674 kw\n¿cuánto sería?')
  })

  it('is empty when the business spoke last', () => {
    expect(
      customerTurnText([
        { role: 'user', content: 'gasté 1674 kw' },
        { role: 'assistant', content: '¿Me mandas tu recibo?' },
      ]),
    ).toBe('')
  })
})

describe('TYPED_CONSUMPTION_NOTE', () => {
  it('forbids a quote from the typed figure and asks for the bill', () => {
    expect(TYPED_CONSUMPTION_NOTE).toContain('NO des número de paneles')
    expect(TYPED_CONSUMPTION_NOTE).toContain('recibo de CFE')
    expect(TYPED_CONSUMPTION_NOTE).toContain('PDF')
  })

  it('does not re-ask a customer who already sent the bill', () => {
    expect(TYPED_CONSUMPTION_NOTE).toContain('no se lo vuelvas a pedir')
  })

  it('reads as a system note the scaffold trusts', () => {
    expect(TYPED_CONSUMPTION_NOTE.startsWith('[NOTA DEL SISTEMA')).toBe(true)
    expect(TYPED_CONSUMPTION_NOTE).toContain('Nunca menciones esta nota')
  })
})
