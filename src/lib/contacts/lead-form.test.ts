import { describe, it, expect } from 'vitest'
import { parseLeadForm, canonicalTarget } from './lead-form'

/** The real click-to-WhatsApp questionnaire, verbatim (typos included —
 *  "¿Cuál e el tamaño…" is how the ad actually sends it). */
const REAL_FORM = `¡Hola! Completé el formulario y me gustaría obtener más información sobre tu negocio.

Phone number: +52019982123863
City: Cancún
¿Estás interesada/o en opciones de financiamiento?: Si
¿Cuál e el tamaño aproximado de tu techo?: Menos de 100 m2
¿Qué tipo de propiedad deseas equipar con Paneles Solares?: Casa
Full name: Arley Ramirez
Email: argrnisram0610@gmail.com
¿Cuánto pagas en promedio en electricidad?: De $2000 a $5000`

describe('parseLeadForm', () => {
  it('parses the real questionnaire into all its pairs', () => {
    const pairs = parseLeadForm(REAL_FORM)
    expect(pairs).not.toBeNull()
    expect(pairs).toHaveLength(8)
    const byKey = new Map(pairs!.map((p) => [p.key, p.value]))
    expect(byKey.get('City')).toBe('Cancún')
    expect(byKey.get('Full name')).toBe('Arley Ramirez')
    expect(
      byKey.get('¿Cuánto pagas en promedio en electricidad?'),
    ).toBe('De $2000 a $5000')
  })

  it('rejects ordinary prose, even with a colon or two', () => {
    expect(parseLeadForm('hola quiero paneles')).toBeNull()
    expect(
      parseLeadForm('ojo: dos cosas\nprimero el precio\nsegundo: la garantía'),
    ).toBeNull()
  })

  it('ignores the greeting line and blank lines', () => {
    const pairs = parseLeadForm(REAL_FORM)!
    expect(pairs.every((p) => !p.key.includes('¡Hola!'))).toBe(true)
  })
})

describe('canonicalTarget', () => {
  it('routes identity fields to the contact row', () => {
    expect(canonicalTarget('Full name')).toEqual({ kind: 'name' })
    expect(canonicalTarget('Email')).toEqual({ kind: 'email' })
  })

  it('skips the form phone — the WhatsApp sender number is authoritative', () => {
    expect(canonicalTarget('Phone number')).toEqual({ kind: 'skip' })
  })

  it('maps known questions to short stable field names', () => {
    expect(canonicalTarget('City')).toEqual({
      kind: 'custom',
      fieldName: 'Ciudad',
    })
    expect(
      canonicalTarget('¿Estás interesada/o en opciones de financiamiento?'),
    ).toEqual({ kind: 'custom', fieldName: 'Interesado en financiamiento' })
    expect(canonicalTarget('¿Cuál e el tamaño aproximado de tu techo?')).toEqual(
      { kind: 'custom', fieldName: 'Tamaño de techo' },
    )
    expect(
      canonicalTarget(
        '¿Qué tipo de propiedad deseas equipar con Paneles Solares?',
      ),
    ).toEqual({ kind: 'custom', fieldName: 'Tipo de propiedad' })
    expect(
      canonicalTarget('¿Cuánto pagas en promedio en electricidad?'),
    ).toEqual({ kind: 'custom', fieldName: 'Pago promedio de luz' })
  })

  it('falls back to the question text for unknown fields (nothing dropped)', () => {
    expect(canonicalTarget('¿Cómo nos conociste?')).toEqual({
      kind: 'custom',
      fieldName: 'Cómo nos conociste',
    })
  })
})
