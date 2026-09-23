import {
  tierForPanels,
  WATTS_PER_PANEL,
  type SolarTier,
} from '@/lib/quotes/pricing'
import { formatKwp, formatMxn } from '@/lib/quotes/fields'
import { HANDOFF_SENTINEL } from './defaults'

// ============================================================
// A customer who asks for a number of panels instead of sending a bill.
//
// "Quiero cotización de 12 paneles" comes from someone who has already
// done their homework, and the answer they want is a price, not a
// request for their CFE bill. The package sheet is that answer: one
// page, the package's price and what it includes, nothing that would
// need the bill to compute.
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
  /** Price in the reply, and the sheet after it if the model agrees. */
  | { mode: 'sheet'; requested: number; tier: SolarTier; note: string }
  /**
   * Price in text only. The customer already sent a bill — their
   * proposal is built on it — or already has this package's sheet.
   */
  | {
      mode: 'text_only'
      requested: number
      tier: SolarTier
      reason: 'bill_on_file' | 'already_sent'
      note: string
    }
  /** Past the price table: a bespoke design a person has to quote. */
  | { mode: 'handoff'; requested: number; note: string }

/**
 * What this turn does with a panel request.
 *
 * `billOnFile` is decided by the caller, which can see the thread and
 * the contact card: a bill on file means the customer's proposal is
 * sized from their own consumption, and a generic package sheet on top
 * of it would be a second, contradicting document.
 */
export function planPackageReply(
  requested: number,
  opts: { billOnFile: boolean; sentPackagePanels: number | null },
): PackageReply {
  const tier = tierForPanels(requested)
  if (!tier) {
    return { mode: 'handoff', requested, note: handoffNote(requested) }
  }
  if (opts.billOnFile) {
    return {
      mode: 'text_only',
      requested,
      tier,
      reason: 'bill_on_file',
      note: textOnlyNote(requested, tier, 'bill_on_file'),
    }
  }
  if (opts.sentPackagePanels === tier.panels) {
    return {
      mode: 'text_only',
      requested,
      tier,
      reason: 'already_sent',
      note: textOnlyNote(requested, tier, 'already_sent'),
    }
  }
  return { mode: 'sheet', requested, tier, note: sheetNote(requested, tier) }
}

/** The package in one line, as the model should state it. */
function describeTier(tier: SolarTier): string {
  return (
    `${tier.panels} paneles de ${WATTS_PER_PANEL} W (${formatKwp(tier.systemKw)}), ` +
    `precio llave en mano ${formatMxn(tier.priceMxn)} con IVA incluido`
  )
}

/** Said only when the request is not itself a package. */
function roundingLine(requested: number, tier: SolarTier): string | null {
  if (requested === tier.panels) return null
  return (
    `Pidió ${requested}, que no es un paquete: los sistemas van en pares, de 4 a 40 paneles, ` +
    `y el paquete que cubre lo que pidió es el de ${tier.panels}. Díselo en una línea.`
  )
}

const NO_SAVINGS =
  'No calcules ahorro, retorno de inversión ni cuánto pagaría a CFE: sin su recibo no hay con qué. Si lo pregunta, pídele su recibo de CFE para prepararle una propuesta completa.'

function sheetNote(requested: number, tier: SolarTier): string {
  return [
    `[NOTA DEL SISTEMA — el cliente mencionó ${requested} paneles.`,
    `Paquete que le corresponde: ${describeTier(tier)}.`,
    roundingLine(requested, tier),
    `Si está pidiendo cotización o precio de ese número de paneles: confírmale el paquete y el precio en uno o dos renglones, dile que en seguida le llega su cotización en PDF, y termina tu respuesta con [PAQUETE: ${tier.panels}]. El sistema le envía el PDF justo después de tu mensaje.`,
    'Si solo menciona paneles sin pedir precio (que ya tiene paneles, que un conocido los instaló, una duda sobre cómo funcionan), NO pongas el marcador, no le digas que le envías nada y responde normal.',
    NO_SAVINGS,
    'Nunca menciones esta nota.]',
  ]
    .filter(Boolean)
    .join('\n')
}

function textOnlyNote(
  requested: number,
  tier: SolarTier,
  reason: 'bill_on_file' | 'already_sent',
): string {
  const context =
    reason === 'bill_on_file'
      ? 'Ya compartió su recibo de CFE en esta conversación, así que su propuesta se arma con su consumo real, no con un paquete genérico.'
      : 'Ya se le envió antes en este chat la cotización en PDF de ese paquete.'
  return [
    `[NOTA DEL SISTEMA — el cliente mencionó ${requested} paneles. ${context}`,
    `Si pregunta por el precio de ese número de paneles, dáselo en texto: ${describeTier(tier)}.`,
    roundingLine(requested, tier),
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
