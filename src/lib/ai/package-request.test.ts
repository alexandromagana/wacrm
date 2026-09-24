import { describe, it, expect } from 'vitest'
import { detectPanelRequest, planPackageReply } from './package-request'

describe('detectPanelRequest', () => {
  it.each([
    ['Hola, quiero una cotización de 12 paneles', 12],
    ['cuanto sale con 14 paneles solares?', 14],
    ['Me interesa un sistema de doce paneles', 12],
    ['cotízame dieciséis placas', 16],
    ['precio de treinta y dos módulos', 32],
    ['¿Cuánto cuesta un panel?', 1],
    ['quiero 50 paneles para mi negocio', 50],
  ])('reads the count in %j', (text, count) => {
    expect(detectPanelRequest(text)).toBe(count)
  })

  it('takes the last count in the turn', () => {
    // A burst arrives in order; the latest figure is the question.
    expect(detectPanelRequest('tengo 6 paneles\ncotízame 12 paneles')).toBe(12)
  })

  it.each([
    'Hola, quiero información de paneles solares',
    'Los paneles son de 625 W por panel?',
    'Gasté 1674 kw en el último recibo',
    'un sistema de 10 kW',
    'unos paneles para mi casa',
    'El panel de control no prende',
  ])('finds no count in %j', (text) => {
    expect(detectPanelRequest(text)).toBeNull()
  })
})

describe('planPackageReply', () => {
  const nothingSent = { sentPackagePanels: null }

  it('offers the sheet for a package count, with the marker to emit', () => {
    const reply = planPackageReply(12, nothingSent)
    expect(reply.mode).toBe('sheet')
    expect(reply.note).toMatch(/^\[NOTA DEL SISTEMA/)
    expect(reply.note).toContain('[PAQUETE: 12]')
    expect(reply.note).toContain('PDF SÍ se envía en este turno')
    expect(reply.note).toContain('Nunca menciones esta nota.]')
    // A package count needs no explanation of the rounding.
    expect(reply.note).not.toContain('no es un paquete')
  })

  it('keeps the price out of the chat — it travels in the PDF', () => {
    const reply = planPackageReply(12, nothingSent)
    expect(reply.note).not.toMatch(/\$\s?\d/)
    expect(reply.note).toContain('No escribas el precio')
  })

  it('rounds an odd count up and tells the model to say so', () => {
    const reply = planPackageReply(13, nothingSent)
    expect(reply.mode).toBe('sheet')
    if (reply.mode !== 'sheet') return
    expect(reply.tier.panels).toBe(14)
    expect(reply.note).toContain('[PAQUETE: 14]')
    expect(reply.note).toContain('Pidió 13, que no es un paquete')
  })

  it('does not resend a sheet this contact already has', () => {
    const reply = planPackageReply(12, { sentPackagePanels: 12 })
    expect(reply.mode).toBe('already_sent')
    expect(reply.note).not.toContain('[PAQUETE')
    expect(reply.note).toContain('NO envía ningún archivo')
    expect(reply.note).not.toMatch(/\$\s?\d/)
  })

  it('sends a different package even after one went out', () => {
    expect(planPackageReply(16, { sentPackagePanels: 12 }).mode).toBe('sheet')
  })

  it('hands off past the table, without a price', () => {
    const reply = planPackageReply(50, nothingSent)
    expect(reply.mode).toBe('handoff')
    expect(reply.note).toContain('[[HANDOFF]]')
    expect(reply.note).not.toMatch(/\$\s?\d/)
  })
})
