// ============================================================
// What a receipt reading is made of, and how one typed by hand is
// validated before it is allowed anywhere near a price.
//
// Lives in `src/lib/quotes` — which is deliberately free of AI/Meta
// imports — because both sides need it: the browser form that collects
// the numbers, and the server that prices them. `src/lib/ai/receipt`
// imports the cap from here rather than the other way round.
// ============================================================

/**
 * Máximo de bimestres históricos considerados. Junto con el periodo
 * actual da 6 periodos = 1 año de consumo — el tope es un límite duro
 * en código, no solo una instrucción de prompt, para que un recibo con
 * más barras en la gráfica (o un modelo que no siga la instrucción)
 * nunca infle el promedio con datos de más de un año atrás.
 *
 * The hand-capture form is held to the same ceiling, so a quote built
 * from typed numbers averages the same window as one read by the model.
 */
export const MAX_HISTORIAL_BIMESTRES = 5

/** Meters one quote may cover. Mirrors the upload form's own ceiling. */
export const MAX_MANUAL_METERS = 4

/** Longest a free-text field may be before it is a paste, not a value. */
const TEXT_MAX = 120

/**
 * A bill's numbers as a person would type them off the paper — one
 * block per meter. Every field is optional: the form starts empty, or
 * pre-filled with whatever the vision model did manage to read, and the
 * user fills in the rest.
 */
export interface ManualMeterReading {
  consumo_periodo_actual_kwh: number | null
  /**
   * Nulls are allowed so a field being typed into can be empty without
   * the row vanishing under the caret. `parseManualReadings` drops them
   * on the way in, and `buildExtraction` ignores anything non-numeric,
   * so an empty slot never reaches the average as a zero — which would
   * drag it down and read downstream as an empty house.
   */
  historial_bimestres_kwh: (number | null)[]
  importe_periodo_mxn: number | null
  importe_dap_mxn: number | null
  historial_bimestres_importe_mxn: (number | null)[]
  tarifa: string | null
  ciudad: string | null
  numero_servicio: string | null
}

/** An empty block, for a form opening on a meter with nothing read. */
export function emptyManualReading(): ManualMeterReading {
  return {
    consumo_periodo_actual_kwh: null,
    historial_bimestres_kwh: [],
    importe_periodo_mxn: null,
    importe_dap_mxn: null,
    historial_bimestres_importe_mxn: [],
    tarifa: null,
    ciudad: null,
    numero_servicio: null,
  }
}

/**
 * A consumption/amount as typed. Accepts the number itself or the
 * string a form field yields, tolerating the separators people actually
 * type ("1,611", "$3,791.20", "1 611"). Anything else — NaN, Infinity,
 * a negative, an empty field — reads as "not given".
 */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\s,$]/g, '')
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function toText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, TEXT_MAX)
  return trimmed || null
}

/**
 * Whether a block carries enough to price anything at all. A meter that
 * was added and left blank is a mistake worth blocking, not an extra to
 * ignore: the quote it produces is short by one meter and looks
 * perfectly normal on the PDF.
 */
export function hasConsumption(reading: ManualMeterReading): boolean {
  return (
    reading.consumo_periodo_actual_kwh != null ||
    reading.historial_bimestres_kwh.some((v) => v != null)
  )
}

/**
 * Validate a `manual_reading` payload posted from the browser into
 * readings the pricing path can use, or null when it is not one.
 *
 * Everything here arrives from a form the user controls, so nothing is
 * taken on trust: the shape, the count, the history length and every
 * individual number are checked, and the two history arrays are read by
 * position so a missing importe cannot shift the rest by one.
 */
export function parseManualReadings(raw: unknown): ManualMeterReading[] | null {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!Array.isArray(parsed)) return null
  if (parsed.length === 0 || parsed.length > MAX_MANUAL_METERS) return null

  const readings: ManualMeterReading[] = []
  for (const block of parsed) {
    if (!block || typeof block !== 'object') return null
    const b = block as Record<string, unknown>

    // Only real numbers survive into the history: a blank row in the
    // form must disappear rather than become a zero, which would drag
    // the average down and read downstream as an empty house.
    const historial: (number | null)[] = (
      Array.isArray(b.historial_bimestres_kwh) ? b.historial_bimestres_kwh : []
    )
      .map(toNumber)
      .filter((v): v is number => v != null)
      .slice(0, MAX_HISTORIAL_BIMESTRES)

    // The importes keep their holes — they are read by index against
    // the kWh above, and a filter here would misalign every later one.
    const historialImporte = (
      Array.isArray(b.historial_bimestres_importe_mxn)
        ? b.historial_bimestres_importe_mxn
        : []
    )
      .map(toNumber)
      .slice(0, MAX_HISTORIAL_BIMESTRES)

    readings.push({
      consumo_periodo_actual_kwh: toNumber(b.consumo_periodo_actual_kwh),
      historial_bimestres_kwh: historial,
      importe_periodo_mxn: toNumber(b.importe_periodo_mxn),
      importe_dap_mxn: toNumber(b.importe_dap_mxn),
      historial_bimestres_importe_mxn: historialImporte,
      tarifa: toText(b.tarifa),
      ciudad: toText(b.ciudad),
      numero_servicio: toText(b.numero_servicio),
    })
  }
  return readings
}
