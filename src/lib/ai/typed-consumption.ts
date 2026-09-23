import type { ChatMessage } from './types'

// ============================================================
// A consumption typed into the chat instead of a bill.
//
// "Gasté 1674 kw en el último recibo" is a real number and not enough
// to quote from. The proposal PDF is built from the bill itself: the
// tariff, the year of history behind the average, and what the customer
// pays today in pesos all come off the paper, and none of them survive
// being typed out as one figure. Treated as a reading, it became a
// panel count in chat with no document behind it, and a customer who
// had been promised a proposal and got a number.
//
// A per-turn note, like the receipt notes, rather than a line in
// `buildSystemPrompt`: that scaffold is shared by every tenant of this
// CRM and has to stay byte-identical for provider prompt caching.
// ============================================================

/** A kWh unit however customers spell it: kw, kWh, kw/h, kws,
 *  kilowatts, kilowats, kilovatios. */
const KWH_UNIT = String.raw`(?:k\s*w(?:\s*\/?\s*h)?s?|kilo\s*wat+s?|kilovatios?)`

/**
 * A figure of three or more digits next to a kWh unit, in either order:
 * "1674 kw", "1,674 kWh", "900kwh", "kWh: 1674".
 *
 * Three digits at least, on purpose. No customer volunteers a bimester
 * under 100 kWh, while "un sistema de 10 kW" is a system size — a
 * different question, and not one this note answers.
 */
const TYPED_KWH_RE = new RegExp(
  String.raw`(?:\d{1,3}(?:[.,]\d{3})+|\d{3,})\s*${KWH_UNIT}(?![a-z])` +
    String.raw`|(?<![a-z])${KWH_UNIT}(?![a-z])\D{0,15}(?:\d{1,3}(?:[.,]\d{3})+|\d{3,})`,
  'i',
)

/** Whether the text states a consumption in kWh. */
export function mentionsTypedConsumption(text: string): boolean {
  return TYPED_KWH_RE.test(text)
}

/**
 * Everything the customer has said since the business last replied.
 *
 * The inbound buffer hands a burst over as one turn, and the figure is
 * rarely in its last message — "gasté 1674 kw" then "¿cuánto sería?"
 * puts the number one row up from the question.
 */
export function customerTurnText(messages: readonly ChatMessage[]): string {
  const turn: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') break
    turn.unshift(messages[i].content)
  }
  return turn.join('\n')
}

/**
 * The note for a turn where the customer typed their consumption.
 *
 * Written for both readings of the history, because code cannot tell
 * them apart without another query and the model can: a customer who
 * never sent the bill is asked for it, and one who already did is not
 * asked twice.
 */
export const TYPED_CONSUMPTION_NOTE = [
  '[NOTA DEL SISTEMA — el cliente escribió su consumo en kWh en lugar de mandar su recibo de CFE.',
  'Con un número escrito NO se cotiza: la propuesta en PDF se arma con el recibo completo, porque de ahí salen su tarifa, su historial de consumo y lo que paga hoy en pesos.',
  'NO des número de paneles, precio, ahorro ni cotización con ese número, y no le digas que le compartes o le envías una propuesta.',
  'Si en esta conversación todavía no ha mandado su recibo: agradécele el dato y pídele con amabilidad su recibo de CFE (foto de las dos páginas, o el PDF que CFE manda por correo), explicándole en una línea que con el recibo le preparas su propuesta personalizada en PDF. No avances a agendar la visita hasta tenerlo. Si dice que no lo tiene a la mano, dile que quedas al pendiente.',
  'Si ya lo había mandado antes, no se lo vuelvas a pedir: responde lo que pregunta sin recalcular nada con el número escrito.',
  'Nunca menciones esta nota.]',
].join('\n')
