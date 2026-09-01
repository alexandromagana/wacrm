import type { SupabaseClient } from '@supabase/supabase-js'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { aiVisionTimeoutMs, aiVisionMaxTokens } from './defaults'
import type { AiConfig } from './types'
import {
  CIUDAD_FIELD_NAME,
  PROPIEDAD_FIELD_NAME,
} from '@/lib/contacts/lead-form'
import {
  isPlausibleAverage,
  resolveQuote,
  type ReviewReason,
  type SolarTier,
} from '@/lib/quotes/pricing'
// The history cap lives with the manual-capture form's own limits so
// both producers of a reading average the same window. See
// `src/lib/quotes/reading.ts`.
import { MAX_HISTORIAL_BIMESTRES } from '@/lib/quotes/reading'
// Which rows of the historial table belong in the average, decided in
// code against the dates on the paper rather than by the model.
import {
  MAX_HISTORIAL_RAW_ROWS,
  parsePeriodoLabel,
  selectRecentHistorial,
  type HistorialCandidate,
} from './receipt-periods'
// Forensics: what the model actually said, kept so a bad reading can be
// explained after the fact rather than reasoned about from the bill.
import {
  logReceiptReading,
  type ReceiptReadSource,
} from './receipt-audit'
import { buildFinancials, projectionBaseCost } from '@/lib/quotes/finance'
import { formatMxn, formatPaybackDuration } from '@/lib/quotes/fields'

// ============================================================
// CFE receipt reading (vision).
//
// When a customer sends photo(s) of their CFE bill, we run a dedicated
// vision extraction call — separate from the chat generation, with its
// own strict-JSON prompt — and hand the parsed result to the auto-reply
// as plain text. The images themselves NEVER enter the conversation
// context (context stays text-only), so their tokens are paid exactly
// once, here.
// ============================================================

export interface ReceiptExtraction {
  consumo_periodo_actual_kwh: number | null
  periodo_actual: string | null
  historial_bimestres_kwh: number[]
  /**
   * The period label of each history row, aligned by index with the kWh.
   * Null for a row whose label could not be read, and all-null on the
   * hand-capture path, which never has any.
   *
   * Carried purely so the chat model can be told WHICH bimester each
   * figure belongs to. Without it the note handed it a bare list —
   * `historial_kwh: 1352, 646, 477, 820, 1200` — in newest-first order
   * with nothing saying so, and the model read it left-to-right as a
   * timeline and announced that "the last few months are low" about the
   * bill's HIGHEST months. It then asked the customer to explain a
   * downturn that never happened, while the PDF (built from the same,
   * correct numbers) went out underneath it.
   */
  historial_bimestres_periodo: (string | null)[]
  cantidad_periodos_usados: number
  promedio_bimestral_kwh: number | null
  /**
   * Whether this bill's own bimester is inside the average. False means
   * page 1's "Total del periodo" was unreadable and the average rests on
   * history alone — priceable, but not without asking first.
   */
  incluye_periodo_actual: boolean
  /**
   * The individual readings the average was taken over, newest first.
   * Carried so the pricing layer can spot a window that mixes an
   * occupied house with an empty one, which an average hides by design.
   */
  periodos_promediados_kwh: number[]
  tarifa: string | null
  /**
   * CFE's "No. de servicio" (RPU) — the meter's identity on paper, and
   * the only field that tells "the same bill sent twice" apart from "a
   * second meter on the same property". Digits only, punctuation
   * stripped, so two readings of one bill compare equal even when the
   * OCR disagrees about the spaces.
   */
  numero_servicio: string | null
  /** City/municipality read off the service address, or null. */
  ciudad: string | null
  /** "Fac. del Periodo" — this bimester's charge, before DAP. */
  importe_periodo_mxn: number | null
  /** Derecho de Alumbrado Público, a municipal levy on the same bill. */
  importe_dap_mxn: number | null
  /**
   * The headline "TOTAL A PAGAR". Carried for cross-checking ONLY —
   * see `costo_periodo_mxn`. Never feed this to a projection.
   */
  importe_total_a_pagar_mxn: number | null
  /** Costs from the history table, aligned by index with the kWh. */
  historial_bimestres_importe_mxn: (number | null)[]
  /**
   * What this bimester of electricity actually cost: period charge plus
   * DAP. Derived here, never read off the bill.
   *
   * This is NOT the total to pay. That total also carries "Adeudo
   * Anterior" and "Su Pago" — debt and credit from previous periods —
   * so on a customer who is one bimester behind it can overstate the
   * period by thousands, and the 25-year projection multiplies the
   * error by 38.9.
   */
  costo_periodo_mxn: number | null
  advertencias: string
}

/** Contact custom field the extracted average lands in (find-or-create). */
export const CONSUMO_FIELD_NAME = 'Consumo promedio (kWh)'

/**
 * Extraction system prompt. Kept in code — NOT in the account's
 * editable business prompt — because it demands raw-JSON output that
 * would poison a conversational prompt if the two ever mixed.
 */
const EXTRACTION_PROMPT = `# TAREA
Vas a recibir una o más imágenes que el cliente envió por WhatsApp,
normalmente las páginas de un recibo de CFE (comisión federal de
electricidad, México). Tu único trabajo es EXTRAER los valores de
consumo tal como aparecen — no calcules promedios ni sumes nada, eso
se hace por fuera.

# CÓMO VIENEN LAS IMÁGENES
Casi nunca son escaneos limpios. Espera fotos RECORTADAS que muestran
solo un pedazo de la hoja, torcidas, giradas, con un dedo encima, en
cualquier orden, y a veces repetidas. Los dos bloques que te importan
(el del periodo actual y el del historial) pueden venir en imágenes
distintas, o uno de los dos puede no venir.

Trabaja con lo que haya: junta la información de TODAS las imágenes
como si fueran un solo recibo, reporta cada campo que alcances a ver, y
deja en null únicamente los que de plano no aparecen en ninguna imagen.
NUNCA descartes la lectura porque el recorte no se parezca al recibo
completo o porque falte el encabezado — un fragmento con los números
correctos vale igual que la hoja entera.

# QUÉ BUSCAR
- El bloque del PERIODO ACTUAL: el consumo en kWh del periodo facturado
  ACTUAL (un solo número — el bimestre que se está cobrando ahora), el
  periodo de facturación (fechas), la tarifa contratada si aparece
  (ej. 1, 1A, DAC, PDBT, GDMTH), el NÚMERO DE SERVICIO (también llamado
  RPU o "No. de servicio" — la cadena larga de dígitos que identifica el
  medidor, normalmente arriba a la derecha o junto al nombre del
  titular; cópiala completa, solo los dígitos), y la ciudad o
  municipio del domicilio del servicio (busca la dirección impresa —
  extrae SOLO la ciudad o municipio, nunca la calle ni el número).

  ⚠️ DÓNDE SALE EL CONSUMO DEL PERIODO. Hay dos formatos, según el
  recibo. Toma el que veas:

  (a) En la fila "Energía (kWh)" de la tabla de conceptos aparecen tres
      números:
          Lectura actual | Lectura anterior | Total del periodo
      Ejemplo real:  1,922  |  1,194  |  728
      El consumo que necesitas es el TOTAL DEL PERIODO (728 en el
      ejemplo) — es decir, la DIFERENCIA entre las dos lecturas.
      NUNCA reportes la "Lectura actual" (1,922): esa es la lectura
      acumulada del medidor, no el consumo del bimestre, y usarla infla
      el promedio y arruina la cotización. Si la columna "Total del
      periodo" no se lee con claridad, calcula tú la resta
      (lectura actual − lectura anterior).

  (b) En la tabla de PRECIOS ESCALONADOS, con encabezados
      "Total periodo | Precio (MXN) | Subtotal (MXN)", el consumo es el
      número que va SOLO en el primer renglón, bajo "Total periodo",
      antes de los escalones. Ejemplo real: aparece 1611 arriba, luego
      los escalones 350, 450, 400 y 411 con su precio y subtotal, y al
      final otra vez 1,611. Verifica que los escalones sumen ese mismo
      número (350+450+400+411 = 1,611) y repórtalo.

  ⚠️ Cómo saber si tomaste la lectura del medidor por error: ese error
  es de ORDEN DE MAGNITUD. La lectura acumulada suele traer 5 o 6
  dígitos y ser varias veces mayor que cualquier bimestre. Sospecha
  solo si tu número es 3 VECES O MÁS que el mayor del historial. Que un
  bimestre de verano supere a todos los del historial es perfectamente
  normal — un verano caluroso es récord de consumo y NO es motivo para
  descartar el número.
- Importes en pesos. En el bloque "Desglose del importe a
  pagar" (o equivalente) reporta por separado, cada uno tal como está
  impreso:
    · "Fac. del Periodo" — lo facturado de ESTE bimestre, con IVA.
      Si el recibo no trae ese renglón, usa el subtotal del periodo
      (energía + IVA). Nunca sumes tú los renglones.
    · "DAP" — Derecho de Alumbrado Público, si aparece.
    · "Total" / "TOTAL A PAGAR" — el número grande.
  ⚠️ NO conviertas el TOTAL A PAGAR en el costo del bimestre. Ese
  total puede incluir "Adeudo Anterior" y "Su Pago" — deuda y pagos de
  periodos anteriores — así que en un cliente atrasado no se parece en
  nada a lo que costó este bimestre. Solo repórtalos por separado; la
  cuenta se hace por fuera.
- El bloque del HISTORIAL: la tabla o gráfica de "Consumo histórico" /
  "Historial de consumo". Transcribe TODOS los renglones que alcances a
  leer, en el MISMO ORDEN en que están impresos, hasta un máximo de 12.
  NO elijas tú cuáles son los más recientes y NO descartes los viejos:
  esa selección se hace por fuera, con las fechas. Tu trabajo es copiar
  la tabla tal como está.
  El periodo actual normalmente NO aparece en esta tabla — el renglón
  más reciente del historial es el bimestre ANTERIOR al que se está
  cobrando. Eso es lo normal y no es un error.
  Por CADA renglón reporta, en tres arreglos que se leen POR POSICIÓN
  (el índice 0 de los tres es el mismo renglón de la tabla):
    · "historial_bimestres_kwh" — el consumo en kWh.
    · "historial_periodos" — el periodo tal como viene impreso en ese
      renglón, copiado literal (ej. "del 10 ABR 26 al 12 JUN 26" o
      "10 ABR 26 - 12 JUN 26"). Esta fecha es la que decide cuáles
      bimestres entran al promedio, así que cópiala con cuidado. Si un
      renglón no trae fecha legible, pon null en su lugar.
    · "historial_bimestres_importe_mxn" — el importe en pesos de ese
      mismo renglón, si la tabla trae esa columna. Si no la trae,
      devuelve un arreglo vacío.
  Si un dato no se alcanza a leer, pon null EN SU LUGAR — nunca
  recorras los valores ni cambies el orden para rellenar un hueco, o
  los tres arreglos dejan de corresponder entre sí.

# SI LA IMAGEN NO ES UN RECIBO DE CFE
Deja todos los campos numéricos en null / lista vacía y explica en
"advertencias" qué es la imagen (ej. "la imagen no es un recibo de
CFE, parece una foto de un techo").

# REGLAS
- Nunca inventes un número que no esté impreso en alguna imagen.
- Pero tampoco tires un número que SÍ está ahí: null es para lo que no
  aparece, no para lo que aparece y te deja con dudas. Si alcanzas a
  leer un valor y no estás del todo seguro, REPÓRTALO y dilo en
  "advertencias" (ej. "el consumo del periodo se ve borroso, podría ser
  1611 o 1811"). Un campo en null cuesta la cotización entera; un campo
  reportado con su duda se revisa en dos segundos.
- Nunca calcules un promedio ni una suma — solo reporta los valores
  crudos que leas. El promedio se calcula por fuera con exactitud a
  partir de lo que reportes. Esto aplica igual a los pesos: reporta
  los renglones tal como vienen y no los combines.
- Los importes van como número, sin signo de pesos, sin comas y con
  los centavos tal cual (10237.85, no "$10,237.85" ni 10237).

# COMPACTO (importante)
Responde de la forma MÁS BREVE posible: solo los 12 campos del JSON de
abajo, nada más. NO agregues campos extra, NO repitas valores, NO
expliques tu razonamiento. Los tres arreglos del historial son listas
simples y planas — nunca objetos, nunca un renglón anidado. Los dos de
números traen números pelones (ej. [1076, 446, 459, 643, 984]); el de
periodos trae cadenas (ej. ["del 10 ABR 26 al 12 JUN 26", ...]).
"advertencias" es una frase corta o cadena vacía, jamás un párrafo.

# FORMATO DE RESPUESTA
Responde ÚNICAMENTE con este JSON, sin texto antes ni después:
{
  "consumo_periodo_actual_kwh": <número o null>,
  "periodo_actual": "<fecha inicio - fecha fin>" o null,
  "historial_bimestres_kwh": [<todos los renglones, máximo 12, en el orden impreso>],
  "historial_periodos": [<mismos renglones, mismo orden, la fecha de cada uno o null>],
  "tarifa": "<tarifa>" o null,
  "numero_servicio": "<No. de servicio / RPU, solo dígitos>" o null,
  "ciudad": "<ciudad o municipio del domicilio>" o null,
  "importe_periodo_mxn": <"Fac. del Periodo" o null>,
  "importe_dap_mxn": <DAP o null>,
  "importe_total_a_pagar_mxn": <el total impreso o null>,
  "historial_bimestres_importe_mxn": [<mismos renglones, mismo orden, o arreglo vacío>],
  "advertencias": "<texto breve, o cadena vacía si todo se leyó bien>"
}`

/**
 * Reduce a read service number to comparable digits, or null when what
 * came back can't be one.
 *
 * The length gate matters more than it looks: this string's whole job is
 * deciding "same bill" vs "second meter", and a hallucinated or
 * half-read value that passes through would split one bill into two
 * meters and make the bot ask a customer with a single meter to confirm
 * meters they don't have. CFE prints 12 digits; the band is wide enough
 * to survive an OCR that drops or invents one, and narrow enough to
 * reject a stray year or an account balance. Anything rejected falls
 * back to comparing the reading's own contents (see `sameMeter`).
 */
export function normalizeServiceNumber(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const digits = String(value).replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 20 ? digits : null
}

/**
 * The values a reading is built from, before any of them are trusted.
 * Deliberately `unknown`-typed: both producers hand over data that
 * came off the wire — a vision model's JSON, or a form someone filled
 * in — and neither may skip the coercion below.
 */
export interface RawReceiptValues {
  consumo_periodo_actual_kwh?: unknown
  periodo_actual?: unknown
  historial_bimestres_kwh?: unknown
  /**
   * The period label of each historial row, read by position against
   * the kWh above. Absent on a hand-typed reading, which is why every
   * consumer of it degrades rather than requires it.
   */
  historial_periodos?: unknown
  tarifa?: unknown
  numero_servicio?: unknown
  ciudad?: unknown
  importe_periodo_mxn?: unknown
  importe_dap_mxn?: unknown
  importe_total_a_pagar_mxn?: unknown
  historial_bimestres_importe_mxn?: unknown
  advertencias?: unknown
}

/**
 * Raised when a reading carries history but no current period — the
 * shape a photo of page 2 alone produces.
 *
 * Exported because it is not only a warning, it is a fact about which
 * half of the bill this reading came from, and `joinPages` has to strip
 * it back off once the other half arrives. A stale copy would reach the
 * model through `formatReceiptNote` and have it ask for a page it is
 * already holding.
 */
export const MISSING_PAGE_ONE_WARNING =
  'no se pudo leer el consumo del periodo actual (página 1); el promedio se calculó solo con el historial y puede no reflejar el consumo de hoy'

/**
 * Turn raw receipt values into a `ReceiptExtraction`: coerce, cap the
 * history, derive the average and the period cost, and raise the two
 * warnings that fall out of the numbers themselves.
 *
 * The average is never taken from the model's own arithmetic — it's
 * computed here, deterministically, from the raw values reported
 * (consumo actual + hasta 5 bimestres del historial). A model
 * summing/averaging 6 numbers by hand is exactly the kind of task LLMs
 * get subtly wrong; code doesn't.
 *
 * Split out of `parseReceiptJson` so a reading typed by hand in the
 * Cotizador is byte-for-byte the same shape as one the vision model
 * produced. Everything downstream — `combineReadings`, `resolveQuote`,
 * `buildFinancials`, `saveReceiptData` — then runs on one code path,
 * with no branch that only the manual reading exercises.
 */
export function buildExtraction(r: RawReceiptValues): ReceiptExtraction {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null

  const consumoActual = num(r.consumo_periodo_actual_kwh)

  // The historial as reported, rebuilt row by row.
  //
  // Read strictly by position: the kWh, its importe and its period label
  // are three columns of ONE row of the table. A row whose kWh is
  // unreadable therefore takes its own importe out with it, instead of
  // letting every later importe shift up a slot and pair with the wrong
  // bimester.
  const rawKwh = Array.isArray(r.historial_bimestres_kwh)
    ? (r.historial_bimestres_kwh as unknown[])
    : []
  const rawImporte = Array.isArray(r.historial_bimestres_importe_mxn)
    ? (r.historial_bimestres_importe_mxn as unknown[])
    : []
  const rawPeriodos = Array.isArray(r.historial_periodos)
    ? (r.historial_periodos as unknown[])
    : []

  const candidates: HistorialCandidate[] = []
  for (let i = 0; i < Math.min(rawKwh.length, MAX_HISTORIAL_RAW_ROWS); i++) {
    const kwh = num(rawKwh[i])
    if (kwh == null) continue
    const periodo = rawPeriodos[i]
    candidates.push({
      kwh,
      importeMxn: num(rawImporte[i]),
      periodo: typeof periodo === 'string' ? periodo : null,
    })
  }

  // Which of those rows are the most recent year, chosen against the
  // dates rather than trusting the order they arrived in. Falls back to
  // that order whenever the labels can't all be read, which is also the
  // hand-capture path — it never has any.
  const selection = selectRecentHistorial(
    candidates,
    MAX_HISTORIAL_BIMESTRES,
    parsePeriodoLabel(
      typeof r.periodo_actual === 'string' ? r.periodo_actual : null,
    )?.end ?? null,
  )
  const historial = selection.selected.map((c) => c.kwh)

  const values = [consumoActual, ...historial].filter(
    (v): v is number => v != null,
  )
  const promedio =
    values.length > 0
      ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
      : null

  // Money. Carried out of the same selected rows, so the peso column can
  // never describe a different set of bimesters than the kWh one.
  //
  // A bill with no importe column at all stays an empty array rather
  // than becoming a row of nulls: "this table has no money in it" and
  // "these bimesters cost an unknown amount" read the same to
  // `projectionBaseCost`, but only the first is true here.
  const importePeriodo = num(r.importe_periodo_mxn)
  const importeDap = num(r.importe_dap_mxn)
  const importeTotal = num(r.importe_total_a_pagar_mxn)
  const historialImporte =
    rawImporte.length > 0 ? selection.selected.map((c) => c.importeMxn) : []

  const costoPeriodo =
    importePeriodo != null ? importePeriodo + (importeDap ?? 0) : null

  const advertencias: string[] = []
  if (typeof r.advertencias === 'string' && r.advertencias) {
    advertencias.push(r.advertencias)
  }
  // What the row selection noticed on its way past: a repeated bimester,
  // a gap in the year, a row that wasn't older than the bill itself.
  // None of these block a quote on their own; they tell whoever reviews
  // it where to look.
  if (selection.warning) advertencias.push(selection.warning)
  // Page 1's consumption is the hardest number on the bill to read —
  // three figures share the "Energía (kWh)" row and only the third is
  // the period. When it comes back null the average quietly becomes an
  // average of older bimesters, which is how a house that was empty last
  // year gets sized for a house nobody lives in. Say so out loud.
  if (consumoActual == null && historial.length > 0) {
    advertencias.push(MISSING_PAGE_ONE_WARNING)
  }
  // A gap between the period charge and the headline total means the
  // customer carries debt or credit from earlier bimesters. Not an
  // error — it is precisely the case where using the total would have
  // poisoned the projection — but worth surfacing to whoever reviews
  // the quote. 2% absorbs the cent-level rounding CFE prints.
  if (costoPeriodo != null && importeTotal != null && costoPeriodo > 0) {
    if (Math.abs(importeTotal - costoPeriodo) / costoPeriodo > 0.02) {
      advertencias.push(
        `el total a pagar ($${importeTotal}) no coincide con el costo del periodo ($${costoPeriodo.toFixed(2)}); probablemente trae adeudo o saldo a favor de bimestres anteriores`,
      )
    }
  }

  return {
    consumo_periodo_actual_kwh: consumoActual,
    periodo_actual:
      typeof r.periodo_actual === 'string' ? r.periodo_actual : null,
    historial_bimestres_kwh: historial,
    historial_bimestres_periodo: selection.selected.map((c) => c.periodo),
    cantidad_periodos_usados: values.length,
    promedio_bimestral_kwh: promedio,
    incluye_periodo_actual: consumoActual != null,
    periodos_promediados_kwh: values,
    tarifa: typeof r.tarifa === 'string' ? r.tarifa : null,
    numero_servicio: normalizeServiceNumber(r.numero_servicio),
    ciudad:
      typeof r.ciudad === 'string' && r.ciudad.trim() ? r.ciudad.trim() : null,
    importe_periodo_mxn: importePeriodo,
    importe_dap_mxn: importeDap,
    importe_total_a_pagar_mxn: importeTotal,
    historial_bimestres_importe_mxn: historialImporte,
    costo_periodo_mxn: costoPeriodo,
    advertencias: advertencias.join('; '),
  }
}

/**
 * Parse + validate the model's raw output into a ReceiptExtraction.
 * Tolerates code fences and stray prose around the JSON object.
 * Returns null when nothing parseable/valid came back.
 *
 * Only concerned with getting a JSON object out of the response; every
 * decision about what the values MEAN lives in `buildExtraction`, which
 * the Cotizador's manual capture calls directly.
 */
export function parseReceiptJson(raw: string): ReceiptExtraction | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  let obj: unknown
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null

  return buildExtraction(obj as RawReceiptValues)
}

/**
 * Guess property type from the CFE tariff code — a business rule, kept
 * deterministic rather than trusting the vision model's reasoning on
 * every call. Conservative: unrecognized/ambiguous codes return null
 * rather than a guess, per "never invent" — a wrong tariff read is not
 * grounds to mislabel a home as a business.
 *
 *   1, 1A–1F, DAC        → doméstica (residential)             → Casa
 *   PDBT                 → pequeña demanda baja tensión         → Negocio
 *   GDBT, GDMTH, GDMTO…  → gran demanda (baja/media tensión)    → Industria
 */
export function inferPropertyType(tarifa: string | null): string | null {
  if (!tarifa) return null
  const t = tarifa.trim().toUpperCase()
  if (t === 'DAC' || /^1[A-F]?$/.test(t)) return 'Casa'
  if (t === 'PDBT') return 'Negocio'
  if (t.startsWith('GD')) return 'Industria'
  return null
}

/**
 * Sanity bounds for a bimonthly average. Defined in `@/lib/quotes` and
 * re-exported here for the existing callers: it gates what we're willing
 * to put a price on, which is a quoting rule, and `src/lib/quotes` is
 * deliberately free of AI/Meta imports so it stays standalone.
 */
export { isPlausibleAverage }

/**
 * How the model is told to report a meter count back to us.
 *
 * Deliberately injected per-turn — inside the receipt note and the
 * gate's own note — rather than added to `buildSystemPrompt`. That
 * scaffold is shared by every tenant of this CRM, most of whom have
 * nothing to do with CFE bills, and it must stay byte-identical across
 * turns for provider prompt caching. Here the instruction costs nothing
 * until a conversation actually has meters in play.
 */
/**
 * What the model is told on a turn whose PDF is already cleared to go.
 *
 * The document is sent by code the moment the reply lands, from a
 * verdict the model never sees. Left unsaid, the two drift: the pricing
 * layer reads a clean window, ships the proposal, and the model — on
 * its own reading of the same bill — spends that turn asking a
 * question, so the customer gets an interrogation with a quote stapled
 * underneath it. Saying "this is going out now" is what keeps the
 * message and the document describing one decision.
 */
export const QUOTE_SHIPPING_INSTRUCTION =
  'IMPORTANTE: la propuesta en PDF SE ENVÍA automáticamente en cuanto termines este mensaje, con exactamente esos números. Tu mensaje es el que la presenta: dale al cliente el número de paneles y el ahorro, y NO le digas que se la vas a preparar o mandar después — ya va en camino.'

/**
 * The model's veto over that send.
 *
 * The guard in `pricing.ts` only runs one way: when CODE distrusts the
 * window it forbids the model to quote. Nothing ran the other way, so a
 * model that decided to ask something first had no way to hold the
 * document back — it asked, and the PDF went out under the question
 * anyway. This is that missing direction, and it is deliberately a
 * marker rather than a heuristic on the reply text: "did this message
 * mean to quote or to ask" is exactly the judgement the model is
 * already making, so let it say so instead of guessing at it afterwards.
 */
export const QUOTE_HOLD_MARKER_INSTRUCTION =
  'Si necesitas preguntar algo ANTES de que salga el PDF (algo del recibo no te cuadra, el cliente pidió esperar, quieres confirmar un dato), TERMINA tu mensaje con el marcador [ESPERAR: motivo breve] — por ejemplo "[ESPERAR: confirmar si el historial es de esta casa]". Con ese marcador el PDF NO sale en este turno y la cotización queda guardada tal cual para retomarla en cuanto el cliente conteste. El marcador se borra antes de enviar y el cliente nunca lo ve. Sin marcador el PDF sale de todas formas, así que no preguntes y dejes que la propuesta salga debajo de tu pregunta.'

/**
 * How a parked quote gets released — or buried.
 *
 * Same shape as `METERS_MARKER_INSTRUCTION`, and for the same reason:
 * the answer arrives as prose on a turn that carries no receipt, and
 * without a marker to carry it the customer's "sí, así gasto siempre"
 * falls on the floor and the quote they were promised never comes.
 *
 * No plain-language fallback here, unlike the meter gate: "are those
 * all your meters" has a yes and a no, while "was the house empty" is
 * answered in open prose that no word list can be trusted to read.
 * The ask bound in `meters.ts` is what covers a missed marker — after
 * two turns a person takes the thread.
 */
export const CONSUMO_MARKER_INSTRUCTION =
  'En cuanto el cliente conteste, TERMINA tu mensaje con UNO de estos marcadores (se borran antes de enviar, el cliente nunca los ve): ' +
  '[CONSUMO: NORMAL] si dijo que así es su consumo de siempre, que la casa ha estado habitada, o que lo que subió fueron las tarifas de CFE — con ese marcador la propuesta sale de inmediato con los números de arriba. ' +
  '[CONSUMO: ATIPICO] si dijo que la casa estuvo desocupada, en obra, que apenas la va a habitar, o cualquier cosa que haga que ese historial NO represente lo que va a gastar — con ese marcador no sale PDF y un compañero retoma la cotización. ' +
  'Si su respuesta todavía no aclara cuál de las dos es, no pongas ningún marcador y vuelve a preguntarlo con amabilidad.'

export const METERS_MARKER_INSTRUCTION =
  'Si el cliente dice (ahora o en cualquier mensaje posterior) cuántos medidores tiene en total, o confirma que ya no hay más, TERMINA tu mensaje con el marcador [MEDIDORES: N] donde N es el total de medidores de la propiedad (ej. "[MEDIDORES: 3]"; si confirma que solo es el que ya mandó, "[MEDIDORES: 1]"). El marcador se borra antes de enviar y el cliente nunca lo ve. Sin él la cotización se queda esperando recibos que ya no van a llegar.'

/**
 * What the meter gate knows about this turn, when the reading came from
 * a property split across several CFE meters.
 *
 * Declared here rather than in `meters.ts` so this module keeps its
 * one-way dependency: `meters.ts` imports the reading, never the other
 * way round.
 */
export interface MeterNoteContext {
  /** Bills behind this reading. Above 1, every number is already a sum. */
  count: number
  /**
   * Set while the gate is still open — the reading is real but
   * incomplete, so this turn asks and does not price. Mirrors how
   * `needs_review` suppresses a quote below: the PDF is held on the
   * same turn the note forbids the model to state a number, or the
   * customer gets a firm price for part of their house.
   */
  pending?:
    | { kind: 'awaiting_more'; expected: number }
    | { kind: 'awaiting_confirmation' }
}

/**
 * The reading itself, as the lines every note about it opens with.
 *
 * Shared by `formatReceiptNote` and `formatHeldQuoteNote` so a quote
 * parked for review comes back on a later turn describing the SAME
 * bill in the same words — the model has no other copy of these
 * numbers, and two spellings of one reading is how a bot ends up
 * quoting a figure the PDF never carried.
 *
 * Every history figure is married to the bimester it belongs to. The
 * bare comma-list this replaced said nothing about direction, and a
 * newest-first list read left-to-right as a timeline is a downward
 * trend that isn't there.
 */
function formatReadingLines(r: ReceiptExtraction): string[] {
  const lines = [
    `promedio_bimestral_kwh: ${r.promedio_bimestral_kwh ?? 'no legible'}`,
  ]
  if (r.consumo_periodo_actual_kwh != null) {
    const periodo = r.periodo_actual ? `, ${r.periodo_actual}` : ''
    lines.push(
      `consumo_periodo_actual_kwh: ${r.consumo_periodo_actual_kwh} (el bimestre que se está cobrando ahora${periodo})`,
    )
  }
  if (r.historial_bimestres_kwh.length > 0) {
    // Defensive: a reading stored before this field existed comes back
    // without it, and a note that throws costs the customer their reply.
    const periodos: (string | null)[] = Array.isArray(
      r.historial_bimestres_periodo,
    )
      ? r.historial_bimestres_periodo
      : []
    const dated = periodos.some((p) => p)
    const rows = r.historial_bimestres_kwh.map((kwh, i) => {
      const periodo = periodos[i]
      return periodo ? `${kwh} (${periodo})` : `${kwh}`
    })
    lines.push(
      `historial_kwh — bimestres ANTERIORES, del MÁS RECIENTE al MÁS ANTIGUO` +
        `${dated ? '' : ' (el recibo no traía fechas legibles)'}: ${rows.join(' | ')}`,
      'OJO con el orden: el primero de esa lista es el bimestre pasado y el último es el más viejo. Leerla al revés convierte los meses más altos en "los últimos meses vienen bajos", que es justo lo contrario de lo que dice el recibo.',
    )
  }
  return lines
}

/** The resolved system, spelled out so the model never has to map
 *  kWh → paneles itself. */
function formatTierLines(tier: SolarTier): string[] {
  return [
    `sistema_cotizado: ${tier.panels} paneles, ${tier.systemKw} kW, ${formatMxn(tier.priceMxn)} (precio llave en mano, IVA incluido)`,
    'Ese número de paneles y ese precio salen de la tabla oficial ya resuelta contra el promedio de arriba. Úsalos tal cual: NO los recalcules ni los estimes por tu cuenta.',
  ]
}

/**
 * Render the extraction as the bracketed system note the auto-reply
 * model receives as a user-role message. Mirrors the date/time
 * injection pattern: context reaches the model inside the turn, the
 * cached system prompt stays untouched.
 */
export function formatReceiptNote(
  r: ReceiptExtraction,
  meters?: MeterNoteContext,
): string {
  const lines: string[] = [
    '[NOTA DEL SISTEMA — el cliente acaba de enviar imagen(es) de su recibo de CFE. Lectura automática:',
  ]
  if (meters && meters.count > 1) {
    lines.push(
      `medidores_leidos: ${meters.count} (esta propiedad tiene el consumo repartido en varios medidores; TODAS las cifras de abajo ya son la SUMA de los ${meters.count} recibos, no las vuelvas a sumar)`,
    )
  }
  lines.push(...formatReadingLines(r))
  if (r.costo_periodo_mxn != null) {
    lines.push(
      `costo_bimestral_mxn: ${r.costo_periodo_mxn.toFixed(2)} (lo que costó este bimestre de luz; NO es el total a pagar del recibo)`,
    )
  }
  if (r.tarifa) lines.push(`tarifa: ${r.tarifa}`)
  // The projection the PDF will print, handed back to the model for the
  // same reason `pricing.ts` hands back the tier: if the bot quotes one
  // set of savings in chat and the document shows another, the customer
  // is the one who notices.
  const quote = resolveQuote(
    r.promedio_bimestral_kwh,
    r.cantidad_periodos_usados,
    {
      includesCurrentPeriod: r.incluye_periodo_actual,
      periods: r.periodos_promediados_kwh,
    },
  )
  // The meter gate outranks the pricing checks below: a reading that
  // covers two of a customer's three meters prices perfectly cleanly and
  // is still the wrong number. Quoting it sizes the system for part of
  // the house — the one error the customer cannot spot on the PDF.
  const pending = meters?.pending
  if (pending) {
    const missing =
      pending.kind === 'awaiting_more'
        ? Math.max(pending.expected - meters.count, 0)
        : 0
    lines.push(
      pending.kind === 'awaiting_more'
        ? `medidores_incompletos: el cliente dijo que tiene ${pending.expected} medidores y solo llevamos ${meters.count}. Falta(n) ${missing}.`
        : `medidores_multiples: llegaron ${meters.count} recibos de medidores DISTINTOS y el cliente nunca dijo cuántos tiene en total.`,
      'NO des precio, ni número de paneles, ni cotización en este mensaje, y NO se enviará PDF.',
      pending.kind === 'awaiting_more'
        ? `Tu única tarea en este turno es pedirle con amabilidad el/los ${missing} recibo(s) que faltan, completos y con sus dos páginas. En cuanto lleguen se suma todo y se cotiza de una vez.`
        : 'Tu única tarea en este turno es preguntarle si esos son TODOS sus medidores o si tiene alguno más. No cotices hasta saberlo: sumar solo una parte de su consumo le vende un sistema que se queda corto.',
      'Si el cliente aprovecha para preguntar otra cosa (financiamiento, tiempos, garantías), respóndela con gusto y vuelve a hacer tu pregunta al final del mensaje.',
      METERS_MARKER_INSTRUCTION,
    )
  }
  // A window that prices cleanly but is not trustworthy. No PDF goes out
  // on this turn (`sendQuoteProposal` skips the same resolution), so the
  // note has to stop the model from quoting the number in text either —
  // otherwise the customer gets a firm price the company has to walk
  // back once they answer.
  if (!pending && quote.kind === 'needs_review') {
    const diagnostico =
      quote.reason === 'missing_current_period'
        ? 'lectura_incompleta: no se leyó el consumo del bimestre actual. Antes de dar cualquier número, pídele con amabilidad una foto nítida de la PRIMERA página del recibo, donde viene el renglón "Energía (kWh)".'
        : quote.reason === 'anomalous_history_high'
          ? `consumo_irregular_alto: el historial trae un bimestre de ${quote.outlierKwh} kWh, muy por encima del promedio de ${quote.kwh} kWh. Eso normalmente significa un bimestre fuera de lo normal (visitas, obra, un aire nuevo) o que ese número se leyó mal del recibo.`
          : `consumo_irregular: el historial trae un bimestre de ${quote.outlierKwh} kWh, muy por debajo del promedio de ${quote.kwh} kWh. Eso normalmente significa que la casa estuvo desocupada, en obra, o que apenas la van a habitar.`
    const tarea =
      quote.reason === 'missing_current_period'
        ? 'Tu única tarea en este turno es pedir esa página. Espera a tenerla antes de cotizar.'
        : quote.reason === 'anomalous_history_high'
          ? 'Tu única tarea en este turno es preguntarle si ese bimestre tan alto tiene explicación o si así es su consumo normal. Espera su respuesta antes de cotizar: si ese número está mal, le estaríamos vendiendo un sistema más grande y más caro del que necesita.'
          : 'Tu única tarea en este turno es preguntar cuál de esas situaciones aplica: si la casa estuvo desocupada, si apenas la va a habitar, o si así es su consumo normal. Espera su respuesta antes de cotizar — dimensionar con el promedio equivocado le vende un sistema que no le alcanza.'
    lines.push(diagnostico)
    lines.push(
      'NO des precio, ni número de paneles, ni cotización en este mensaje, y NO se enviará PDF.',
      tarea,
      'Si el cliente aprovecha para preguntar otra cosa (financiamiento, tiempos, garantías), respóndela con gusto y vuelve a hacer tu pregunta al final del mensaje.',
    )
  }
  if (!pending && quote.kind === 'ok') {
    const financials = buildFinancials({
      costoBimestralMxn: projectionBaseCost({
        costoPeriodoMxn: r.costo_periodo_mxn,
        historialImporteMxn: r.historial_bimestres_importe_mxn,
      }),
      tier: quote.tier,
    })
    if (financials) {
      lines.push(
        // The tier itself, not just the projection. The model used to be
        // left to map kWh → paneles against the table in its prompt,
        // which is the one arithmetic step `pricing.ts` exists to take
        // away from it — and on any turn it got that mapping wrong, the
        // message and the PDF disagreed about the size of the system.
        ...formatTierLines(quote.tier),
        `proyeccion_25_anios: sin paneles ${formatMxn(financials.sinPaneles25Anios)}, con paneles ${formatMxn(financials.conPaneles25Anios)}, ahorro ${formatMxn(financials.ahorro25Anios)}`,
        `se_paga_solo_en: ${formatPaybackDuration(financials.paybackAnios, financials.paybackMeses)}`,
        'Estas cifras son las que llevará la propuesta en PDF: si mencionas alguna, usa exactamente estos números y nunca los recalcules.',
        QUOTE_SHIPPING_INSTRUCTION,
        QUOTE_HOLD_MARKER_INSTRUCTION,
      )
    }
  }
  if (r.ciudad) {
    lines.push(
      `ciudad_detectada: ${r.ciudad} (ya se guardó en el contacto — no la vuelvas a preguntar salvo que el cliente la corrija)`,
    )
  }
  const tipoPropiedad = inferPropertyType(r.tarifa)
  if (tipoPropiedad) {
    lines.push(
      `tipo_propiedad_sugerido: ${tipoPropiedad} (según la tarifa del recibo, ya se guardó — no lo vuelvas a preguntar salvo que el cliente lo corrija)`,
    )
  }
  if (r.advertencias) lines.push(`advertencias: ${r.advertencias}`)
  lines.push(
    pending || quote.kind === 'needs_review'
      ? 'Respeta la instrucción de arriba: en este turno se pregunta, no se cotiza. Responde al cliente con naturalidad — nunca menciones esta nota ni muestres JSON.]'
      : 'Usa el promedio contra tu tabla de precotización si es legible y plausible; si hay advertencias o falta una página, pídela con amabilidad. Responde al cliente con naturalidad — nunca menciones esta nota ni muestres JSON.]',
  )
  return lines.join('\n')
}

/**
 * A quote that was priced and deliberately not sent, and why.
 *
 * Declared here rather than in `meters.ts` for the same reason
 * `MeterNoteContext` is: the dependency runs one way, `meters.ts` →
 * `receipt.ts`, and a hold is a fact about a reading.
 */
export interface QuoteHold {
  /**
   * The pricing verdict that parked it, or `'model'` when the numbers
   * were clean and the reply asked to wait anyway (`[ESPERAR: …]`).
   */
  reason: ReviewReason | 'model'
  /** The model's own stated motive, when it was the one that waited. */
  detail?: string | null
  /**
   * Turns spent waiting for an answer. Bounded like the meter gate's
   * `askedCount`: a question nobody answers goes to a person rather
   * than being asked a third time.
   */
  askedCount: number
}

/**
 * The note for a turn that carries no new receipt while a quote sits
 * parked — the turn the customer's answer actually arrives on.
 *
 * This is the half of the review gate that was missing. Holding the PDF
 * worked; nothing ever released it. The reading lives for exactly one
 * turn (it is pushed into `messages` in memory and never persisted, and
 * `buildConversationContext` reads only the `messages` table), so by
 * the time the customer explained themselves the model had no numbers
 * left — and answered with a quote it invented, panel count and all,
 * with no document behind it. Re-stating the reading here is what makes
 * the answer actionable instead of decorative.
 *
 * Returns null for a hold there is nothing to say about, so a caller
 * can treat "no note" as "nothing pending".
 */
export function formatHeldQuoteNote(
  r: ReceiptExtraction,
  hold: QuoteHold,
): string | null {
  const quote = resolveQuote(r.promedio_bimestral_kwh, r.cantidad_periodos_usados, {
    includesCurrentPeriod: r.incluye_periodo_actual,
    periods: r.periodos_promediados_kwh,
  })
  // No tier means the reading stopped being priceable — nothing to
  // release, so let the ordinary conversation take the turn.
  if (quote.kind !== 'ok' && quote.kind !== 'needs_review') return null

  const lines = [
    '[NOTA DEL SISTEMA — hay una cotización LISTA y en pausa para este cliente, del recibo que ya mandó. No se le ha enviado el PDF porque quedó una pregunta abierta. Estos son sus números, los mismos de antes:',
    ...formatReadingLines(r),
    ...formatTierLines(quote.tier),
  ]

  const financials = buildFinancials({
    costoBimestralMxn: projectionBaseCost({
      costoPeriodoMxn: r.costo_periodo_mxn,
      historialImporteMxn: r.historial_bimestres_importe_mxn,
    }),
    tier: quote.tier,
  })
  if (financials) {
    lines.push(
      `proyeccion_25_anios: sin paneles ${formatMxn(financials.sinPaneles25Anios)}, con paneles ${formatMxn(financials.conPaneles25Anios)}, ahorro ${formatMxn(financials.ahorro25Anios)}`,
      `se_paga_solo_en: ${formatPaybackDuration(financials.paybackAnios, financials.paybackMeses)}`,
    )
  }

  // The page-1 hold is not a question about how the customer lives; it
  // is a missing photo. It is released by the image arriving, which
  // takes the ordinary path — so this turn re-asks and offers no
  // marker, because there is nothing here for one to decide.
  if (hold.reason === 'missing_current_period') {
    lines.push(
      'pregunta_pendiente: falta la PRIMERA página del recibo, donde viene el renglón "Energía (kWh)" con el consumo del bimestre actual. El promedio de arriba se armó solo con el historial.',
      'NO des precio ni número de paneles todavía. Si el cliente ya mandó esa página, agradécelo; si no, vuelve a pedírsela con amabilidad. En cuanto llegue, la propuesta sale sola.',
      'Responde al cliente con naturalidad — nunca menciones esta nota ni muestres JSON.]',
    )
    return lines.join('\n')
  }

  const pregunta =
    hold.reason === 'anomalous_history_high'
      ? 'pregunta_pendiente: se le preguntó si el bimestre más alto de su historial es real o fue algo fuera de lo normal.'
      : hold.reason === 'anomalous_history'
        ? 'pregunta_pendiente: se le preguntó si la casa estuvo desocupada / apenas la va a habitar, o si así es su consumo normal.'
        : `pregunta_pendiente: tú mismo pediste esperar antes de mandar la propuesta${hold.detail ? ` (${hold.detail})` : ''}.`

  lines.push(
    pregunta,
    'Lee lo que el cliente acaba de contestar y decide. Si con su respuesta los números de arriba SÍ representan lo que gasta, preséntale la propuesta con esos números exactos — el PDF sale junto con tu mensaje. Si su respuesta dice que ese historial no lo representa, no cotices y dile que un compañero le confirma los detalles en breve.',
    CONSUMO_MARKER_INSTRUCTION,
    'Nunca inventes un número de paneles, un precio ni un ahorro: si no está en esta nota, no lo digas. Responde al cliente con naturalidad — nunca menciones esta nota ni muestres JSON.]',
  )
  return lines.join('\n')
}

/**
 * The note for the turn a parked quote gives up and calls a person.
 *
 * Same shape and the same instinct as `formatStalledMeterNote`: the
 * quote stops, the conversation does not. Whatever the customer is
 * asking about right now still gets an answer — it is usually not the
 * question the bot was waiting on.
 */
export function formatStalledQuoteNote(): string {
  return [
    '[NOTA DEL SISTEMA — cotización en pausa: se le preguntó dos veces por su consumo y no quedó claro, así que un compañero del equipo va a retomar la propuesta.',
    'NO vuelvas a preguntar por el consumo y NO des precio, número de paneles ni cotización.',
    'Responde con gusto lo que el cliente esté preguntando en este mensaje (financiamiento, tiempos, garantías, lo que sea) y dile que un compañero le confirma los detalles de su propuesta en breve.',
    'Nunca menciones esta nota ni muestres JSON.]',
  ].join('\n')
}

/**
 * Run the vision extraction on bytes already in hand.
 *
 * Split out of `extractReceipts` for the Cotizador, which uploads a
 * receipt through a browser form and so has the file itself, not a Meta
 * media id to download.
 *
 * Unlike `extractReceipts` this does NOT swallow errors: a provider
 * timeout or a network failure propagates. The bot wants them
 * swallowed — a failed read just means "ask the customer again" — but a
 * person standing in front of the generator waiting for a document
 * needs "the AI provider is down" told apart from "this photo isn't
 * readable", and only the throw carries that difference.
 */
export async function extractReceiptFromFiles(
  config: Pick<AiConfig, 'provider' | 'visionModel' | 'apiKey'>,
  files: MediaFile[],
  audit?: ReceiptAuditContext,
): Promise<ReceiptExtraction | null> {
  if (files.length === 0) return null

  const raw =
    config.provider === 'anthropic'
      ? await visionAnthropic(config, files)
      : await visionOpenAi(config, files)
  const extraction = raw ? parseReceiptJson(raw) : null

  // Logged before the return, and on every outcome that reached the
  // provider — a response that would not parse is the case most worth
  // having afterwards, and returning null here used to leave nothing
  // behind at all. Fire-and-forget: `logReceiptReading` owns its errors,
  // and a customer waiting on a quote does not wait on an audit row.
  if (audit) {
    void logReceiptReading({
      accountId: audit.accountId,
      conversationId: audit.conversationId,
      contactId: audit.contactId,
      source: audit.source,
      provider: config.provider,
      model: config.visionModel,
      rawResponse: raw,
      extraction,
      mediaIds: audit.mediaIds,
    })
  }

  return extraction
}

/**
 * Who a receipt read belongs to, for the forensic log.
 *
 * Optional at every call site: passing nothing reads the bill exactly as
 * before and records nothing, which is what the unit tests do. Both real
 * callers pass it — the media ids come from the group actually read, so
 * a row can be traced back to the images the customer sent.
 */
export interface ReceiptAuditContext {
  accountId: string
  source: ReceiptReadSource
  conversationId?: string | null
  contactId?: string | null
  mediaIds?: readonly string[]
}

/** One extracted bill, tied back to the media it was read from. */
export interface ReceiptReading {
  extraction: ReceiptExtraction
  /** Media ids this reading consumed, so the caller can record them as
   *  read and never pay for the same vision call twice. */
  mediaIds: string[]
}

/** How many media a single turn will look at. Six covers three meters
 *  photographed two pages each — the practical ceiling before a
 *  customer is better served by a human. */
const MAX_MEDIA_PER_TURN = 6

/** Vision calls one turn may spend. The per-conversation rate limit is
 *  consumed once per turn, so this is what actually bounds the cost of
 *  a customer dumping a folder into the chat. */
const MAX_RECEIPTS_PER_TURN = 4

/**
 * Split downloaded media into one group per bill.
 *
 * A PDF is a whole bill — CFE emails it that way — so each gets its own
 * extraction call, which is what makes several meters readable without
 * touching the single-bill prompt.
 *
 * Photos are pages, not bills, and nothing in the bytes says which bill
 * a page belongs to. They stay in one group, which is exactly right for
 * the common case (page 1 + page 2 of one bill) and is the known limit
 * of this split: a customer who photographs three different meters gets
 * one reading back, and the conversation falls back to the bot asking
 * for the rest one at a time. Multi-meter customers overwhelmingly send
 * the PDF, so the split buys the real case without risking the common
 * one.
 */
function groupIntoReceipts(
  files: { file: MediaFile; mediaId: string }[],
): { files: MediaFile[]; mediaIds: string[] }[] {
  const groups: { files: MediaFile[]; mediaIds: string[] }[] = []
  let images: { files: MediaFile[]; mediaIds: string[] } | null = null

  for (const { file, mediaId } of files) {
    if (file.mimeType === 'application/pdf') {
      groups.push({ files: [file], mediaIds: [mediaId] })
      continue
    }
    if (!images) {
      images = { files: [], mediaIds: [] }
      groups.push(images)
    }
    images.files.push(file)
    images.mediaIds.push(mediaId)
  }
  return groups.slice(0, MAX_RECEIPTS_PER_TURN)
}

/**
 * Download the customer's media from Meta and read every bill in it.
 *
 * Returns one reading per bill — usually a single-element array, and
 * more only when the customer sent several PDFs at once. Returns an
 * empty array on any failure: the caller treats that as "no reading"
 * and the bot follows its prompt (ask again / ask for a clearer photo).
 * Never throws.
 */
export async function extractReceipts(args: {
  config: Pick<AiConfig, 'provider' | 'visionModel' | 'apiKey'>
  accessToken: string
  mediaIds: string[]
  /** Media already read on an earlier turn. Skipped rather than
   *  re-extracted — a second read of one bill costs tokens and is not
   *  obliged to agree with the first. */
  skipMediaIds?: readonly string[]
  /** Account/conversation this read belongs to, for the forensic log.
   *  Omitted only by tests. */
  audit?: Omit<ReceiptAuditContext, 'mediaIds' | 'source'>
}): Promise<ReceiptReading[]> {
  const { config, accessToken, mediaIds, skipMediaIds, audit } = args
  const skip = new Set(skipMediaIds ?? [])
  const pending = mediaIds.filter((id) => !skip.has(id))
  if (pending.length === 0) return []

  try {
    // Receipts arrive as photos OR as the PDF CFE emails out — accept
    // both; anything else the burst dragged in (a Word doc, a random
    // download) is skipped by mime.
    //
    // `downloadMedia` sniffs the magic bytes, so `contentType` is the
    // file's real type rather than the label Meta's CDN attached to
    // it. That label was wrong often enough — `application/octet-
    // stream` on a valid CFE bill — that the skip below was silently
    // discarding readable receipts and leaving the bot to ask for a
    // resend of a bill it never opened.
    const downloaded: { file: MediaFile; mediaId: string }[] = []
    for (const mediaId of pending.slice(0, MAX_MEDIA_PER_TURN)) {
      const info = await getMediaUrl({ mediaId, accessToken })
      const { buffer, contentType } = await downloadMedia({
        downloadUrl: info.url,
        accessToken,
      })
      const mimeType = contentType || info.mimeType
      if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf') {
        continue
      }
      downloaded.push({
        file: { base64: buffer.toString('base64'), mimeType },
        mediaId,
      })
    }
    if (downloaded.length === 0) return []

    const readings: ReceiptReading[] = []
    for (const group of groupIntoReceipts(downloaded)) {
      // Per-group try/catch: one unreadable bill out of three must not
      // discard the two that read fine.
      try {
        const extraction = await extractReceiptFromFiles(
          config,
          group.files,
          audit && {
            ...audit,
            source: 'auto_reply',
            // This group's own media, not the whole turn's: one row per
            // bill is what makes a multi-meter read auditable.
            mediaIds: group.mediaIds,
          },
        )
        if (extraction) readings.push({ extraction, mediaIds: group.mediaIds })
      } catch (err) {
        console.error('[ai receipt] one receipt failed to extract:', err)
      }
    }
    return readings
  } catch (err) {
    // AbortSignal.timeout throws a TimeoutError — surface it distinctly
    // so "read failed" on a valid receipt is diagnosable as slowness vs.
    // a genuine provider/network error.
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    console.error(
      `[ai receipt] extraction failed${isTimeout ? ' (timeout)' : ''}:`,
      err,
    )
    return []
  }
}

export interface MediaFile {
  base64: string
  mimeType: string
}

async function visionOpenAi(
  config: Pick<AiConfig, 'visionModel' | 'apiKey'>,
  files: MediaFile[],
): Promise<string | null> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.visionModel,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Recibo del cliente:' },
            ...files.map((f) =>
              f.mimeType === 'application/pdf'
                ? {
                    type: 'file',
                    file: {
                      filename: 'recibo_cfe.pdf',
                      file_data: `data:application/pdf;base64,${f.base64}`,
                    },
                  }
                : {
                    type: 'image_url',
                    image_url: {
                      url: `data:${f.mimeType};base64,${f.base64}`,
                    },
                  },
            ),
          ],
        },
      ],
      max_completion_tokens: aiVisionMaxTokens(),
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(aiVisionTimeoutMs()),
  })
  if (!res.ok) {
    // Log the body, not just the status — an OpenAI 400 explains itself
    // (unsupported detail, image too large, bad model), and we couldn't
    // see why reads were failing with only the status code.
    const body = await res.text().catch(() => '')
    console.error(
      `[ai receipt] OpenAI vision HTTP ${res.status}: ${body.slice(0, 500)}`,
    )
    return null
  }
  const data = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[]
    usage?: {
      completion_tokens?: number
      completion_tokens_details?: { reasoning_tokens?: number }
    }
  } | null
  const choice = data?.choices?.[0]
  if (choice?.finish_reason === 'length') {
    // Break out reasoning tokens: on a reasoning model they eat the
    // budget before any JSON is emitted, which looks identical to a
    // "chatty model" truncation but needs the opposite fix (raise the
    // cap / use a non-reasoning model, not a terser prompt).
    const reasoning = data?.usage?.completion_tokens_details?.reasoning_tokens
    console.error(
      `[ai receipt] OpenAI vision truncated (hit token cap ${aiVisionMaxTokens()}; ` +
        `completion=${data?.usage?.completion_tokens ?? '?'}, reasoning=${reasoning ?? 0}). ` +
        `Model "${config.visionModel}" — if reasoning > 0 this is a reasoning model: raise AI_VISION_MAX_TOKENS or pin a non-reasoning vision model.`,
    )
  }
  return choice?.message?.content ?? null
}

async function visionAnthropic(
  config: Pick<AiConfig, 'visionModel' | 'apiKey'>,
  files: MediaFile[],
): Promise<string | null> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.visionModel,
      max_tokens: aiVisionMaxTokens(),
      system: EXTRACTION_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            ...files.map((f) =>
              f.mimeType === 'application/pdf'
                ? {
                    type: 'document',
                    source: {
                      type: 'base64',
                      media_type: 'application/pdf',
                      data: f.base64,
                    },
                  }
                : {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: f.mimeType,
                      data: f.base64,
                    },
                  },
            ),
            { type: 'text', text: 'Recibo del cliente. Responde solo el JSON.' },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(aiVisionTimeoutMs()),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(
      `[ai receipt] Anthropic vision HTTP ${res.status}: ${body.slice(0, 500)}`,
    )
    return null
  }
  const data = (await res.json().catch(() => null)) as {
    content?: { type: string; text?: string }[]
  } | null
  const text = (data?.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
  return text || null
}

/**
 * Find-or-create a custom field and write its value for a contact.
 * `overwrite: false` skips the write when the contact already has a
 * non-empty value — used for ciudad/tipo de propiedad so a receipt's
 * OCR guess never clobbers an explicit answer the lead form already
 * collected. Consumo always overwrites: the newest reading should win.
 */
export async function upsertField(
  db: SupabaseClient,
  args: {
    accountId: string
    userId: string
    contactId: string
    fieldName: string
    fieldType: 'text' | 'number'
    value: string
    overwrite: boolean
  },
): Promise<void> {
  const { accountId, userId, contactId, fieldName, fieldType, value, overwrite } =
    args

  const { data: existingField, error: readErr } = await db
    .from('custom_fields')
    .select('id')
    .eq('account_id', accountId)
    .eq('field_name', fieldName)
    .maybeSingle()
  if (readErr) throw readErr

  let fieldId = existingField?.id as string | undefined
  if (!fieldId) {
    const { data: created, error: insErr } = await db
      .from('custom_fields')
      .insert({
        account_id: accountId,
        user_id: userId,
        field_name: fieldName,
        field_type: fieldType,
      })
      .select('id')
      .single()
    if (insErr) throw insErr
    fieldId = created.id as string
  }

  if (!overwrite) {
    const { data: existingValue } = await db
      .from('contact_custom_values')
      .select('value')
      .eq('contact_id', contactId)
      .eq('custom_field_id', fieldId)
      .maybeSingle()
    if (existingValue?.value) return // already answered — don't clobber it
  }

  const { error: upErr } = await db.from('contact_custom_values').upsert(
    { contact_id: contactId, custom_field_id: fieldId, value },
    { onConflict: 'contact_id,custom_field_id' },
  )
  if (upErr) throw upErr
}

/**
 * Persist everything learned from a receipt read as contact custom
 * fields: consumo (always overwrites — the newest reading wins), and
 * ciudad / tipo de propiedad (fill-only — the lead form's explicit
 * answer wins over a receipt guess). Each field is independent and
 * swallows its own error, so a failure on one never blocks the others
 * or the customer-facing reply.
 */
export async function saveReceiptData(
  db: SupabaseClient,
  args: {
    accountId: string
    /** Audit owner for freshly-created custom_fields rows. */
    userId: string
    contactId: string
    extraction: ReceiptExtraction
  },
): Promise<void> {
  const { accountId, userId, contactId, extraction } = args
  const base = { accountId, userId, contactId }

  const avg = extraction.promedio_bimestral_kwh
  if (avg != null && isPlausibleAverage(avg)) {
    try {
      await upsertField(db, {
        ...base,
        fieldName: CONSUMO_FIELD_NAME,
        fieldType: 'number',
        value: String(avg),
        overwrite: true,
      })
    } catch (err) {
      console.error('[ai receipt] failed to save consumption field:', err)
    }
  }

  if (extraction.ciudad) {
    try {
      await upsertField(db, {
        ...base,
        fieldName: CIUDAD_FIELD_NAME,
        fieldType: 'text',
        value: extraction.ciudad,
        overwrite: false,
      })
    } catch (err) {
      console.error('[ai receipt] failed to save ciudad field:', err)
    }
  }

  const tipoPropiedad = inferPropertyType(extraction.tarifa)
  if (tipoPropiedad) {
    try {
      await upsertField(db, {
        ...base,
        fieldName: PROPIEDAD_FIELD_NAME,
        fieldType: 'text',
        value: tipoPropiedad,
        overwrite: false,
      })
    } catch (err) {
      console.error('[ai receipt] failed to save tipo de propiedad field:', err)
    }
  }
}
