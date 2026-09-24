import {
  tierForPanels,
  WATTS_PER_PANEL,
  type SolarTier,
} from '@/lib/quotes/pricing'
import { formatKwp } from '@/lib/quotes/fields'
import { HANDOFF_SENTINEL } from './defaults'

// ============================================================
// A customer who asks for a number of panels instead of sending a bill.
//
// "Quiero cotización de 12 paneles" comes from someone who has already
// done their homework, and the answer they want is a price, not a
// request for their CFE bill. The package sheet is that answer: one
// page, the package's price and what it includes, nothing that would
// need the bill to compute. The price travels in the PDF, never in the
// chat — the same rule the bill-based proposal follows.
//
// Only for a count. A consumption typed in kWh is a different customer
// (see `typed-consumption.ts`): they are sizing a system, and the bill
// is what sizes it, so the caller does not reach this module on a turn
// that types one — even when a panel count rides along with it.
//
// Two keys, the same shape as the proposal hold. Code finds the number
// and resolves the package; the model decides whether the customer is
// actually asking for a quote ("cotízame 12 paneles") or just
// mentioning panels ("mi vecino puso 12 paneles"), and says so with
// `[PAQUETE: N]`. The sheet goes out only when both agree — a regex
// alone would quote the neighbour, and a marker alone could quote a
// package nobody mentioned.
//
// A per-turn note, like the receipt notes, rather than a line in
// `buildSystemPrompt`: that scaffold is shared by every tenant and has
// to stay byte-identical for provider prompt caching.
// ============================================================

/** Panel counts customers spell out. Matched after accents are stripped. */
const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiun: 21,
  veintiuno: 21,
  veintiuna: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
}

/** Tens that take "y N" after them: "treinta y dos". */
const TENS = ['treinta', 'cuarenta', 'cincuenta']
const UNITS = ['uno', 'una', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve']

const WORD_RE = [
  `(?:${TENS.join('|')})\\s+y\\s+(?:${UNITS.join('|')})`,
  // Longest first, so "veintiuno" is not read as "veintiun" + "o".
  ...Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length),
].join('|')

/**
 * A count right before the thing counted: "12 paneles", "doce placas",
 * "treinta y dos módulos solares". Only when the two are adjacent — "625
 * W por panel" names a wattage, not a count.
 */
const PANEL_COUNT_RE = new RegExp(
  `(?<![a-z0-9])(\\d{1,3}|${WORD_RE})\\s+(?:paneles|panel|placas|placa|modulos|modulo)(?![a-z])`,
  'g',
)

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

function toCount(token: string): number {
  if (/^\d+$/.test(token)) return Number(token)
  const compound = /^(\S+)\s+y\s+(\S+)$/.exec(token)
  if (compound) return NUMBER_WORDS[compound[1]] + NUMBER_WORDS[compound[2]]
  return NUMBER_WORDS[token]
}

/**
 * The number of panels the customer named, or null. The LAST mention
 * wins: a turn arrives in order, and "tengo 6 paneles, cotízame 12
 * paneles" asks about the 12.
 */
export function detectPanelRequest(text: string): number | null {
  let count: number | null = null
  for (const match of normalize(text).matchAll(PANEL_COUNT_RE)) {
    const n = toCount(match[1].replace(/\s+/g, ' '))
    if (Number.isFinite(n) && n > 0) count = n
  }
  return count
}

export type PackageReply =
  /** The sheet after the reply, if the model agrees it was asked for. */
  | { mode: 'sheet'; requested: number; tier: SolarTier; note: string }
  /** This contact already has this package's sheet: point them to it. */
  | { mode: 'already_sent'; requested: number; tier: SolarTier; note: string }
  /** Past the price table: a bespoke design a person has to quote. */
  | { mode: 'handoff'; requested: number; note: string }

/**
 * What this turn does with a panel request.
 *
 * A customer who already sent a bill still gets the sheet: someone with
 * a 12-panel proposal who asks about 16 wants the 16-panel price, and
 * the price only ever travels in a PDF.
 */
export function planPackageReply(
  requested: number,
  opts: { sentPackagePanels: number | null },
): PackageReply {
  const tier = tierForPanels(requested)
  if (!tier) {
    return { mode: 'handoff', requested, note: handoffNote(requested) }
  }
  if (opts.sentPackagePanels === tier.panels) {
    return {
      mode: 'already_sent',
      requested,
      tier,
      note: alreadySentNote(requested, tier),
    }
  }
  return { mode: 'sheet', requested, tier, note: sheetNote(requested, tier) }
}

/** The package in one line, as the model should state it. No price. */
function describeTier(tier: SolarTier): string {
  return `${tier.panels} paneles de ${WATTS_PER_PANEL} W (${formatKwp(tier.systemKw)})`
}

/** Said only when the request is not itself a package. */
function roundingLine(requested: number, tier: SolarTier): string | null {
  if (requested === tier.panels) return null
  return (
    `Pidió ${requested}, que no es un paquete: los sistemas van en pares, de 4 a 40 paneles, ` +
    `y el paquete que cubre lo que pidió es el de ${tier.panels}. Díselo en una línea.`
  )
}

const NO_PRICE_IN_CHAT =
  'No escribas el precio ni las mensualidades en el chat: van en el PDF.'

const NO_SAVINGS =
  'No calcules ahorro, retorno de inversión ni cuánto pagaría a CFE, y no hables de su recibo: sin recibo no hay con qué. Si pregunta por su ahorro, pídele su recibo de CFE para prepararle una propuesta completa.'

function sheetNote(requested: number, tier: SolarTier): string {
  return [
    `[NOTA DEL SISTEMA — el cliente mencionó ${requested} paneles. Si lo está pidiendo como cotización, la cotización por paquete en PDF SÍ se envía en este turno.`,
    `Paquete que le corresponde: ${describeTier(tier)}.`,
    roundingLine(requested, tier),
    `Si está pidiendo cotización o precio de ese número de paneles: confírmale en uno o dos renglones el paquete y lo que incluye (instalación, trámite ante CFE, monitoreo y seguro contra huracán el primer año), dile que en seguida le llega su cotización en PDF con el precio y las mensualidades, y termina tu respuesta con [PAQUETE: ${tier.panels}]. El sistema le envía el PDF justo después de tu mensaje.`,
    NO_PRICE_IN_CHAT,
    'Si solo menciona paneles sin pedir cotización (que ya tiene paneles, que un conocido los instaló, una duda sobre cómo funcionan), NO pongas el marcador, no le digas que le envías nada y responde normal.',
    NO_SAVINGS,
    'Nunca menciones esta nota.]',
  ]
    .filter(Boolean)
    .join('\n')
}

function alreadySentNote(requested: number, tier: SolarTier): string {
  return [
    `[NOTA DEL SISTEMA — el cliente mencionó ${requested} paneles. Ya se le envió antes en este chat la cotización en PDF del paquete de ${describeTier(tier)}.`,
    roundingLine(requested, tier),
    'Si pregunta por el precio, dile que viene en esa cotización que se le mandó arriba en el chat. ' +
      NO_PRICE_IN_CHAT,
    'El sistema NO envía ningún archivo en este turno: no digas que le mandas, compartes o envías una cotización ni un PDF.',
    'Nunca menciones esta nota.]',
  ]
    .filter(Boolean)
    .join('\n')
}

function handoffNote(requested: number): string {
  return [
    `[NOTA DEL SISTEMA — el cliente mencionó ${requested} paneles. Arriba de 40 paneles el sistema es un diseño a la medida y lo cotiza un asesor, no hay precio de paquete.`,
    `Si está pidiendo cotización o precio: no des ningún precio; dile en una línea que un asesor le prepara la cotización a la medida, y termina tu respuesta con ${HANDOFF_SENTINEL}.`,
    'Si solo menciona paneles sin pedir precio, responde normal y sin el marcador.',
    'Nunca menciones esta nota.]',
  ].join('\n')
}
