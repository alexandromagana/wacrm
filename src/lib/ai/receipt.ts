import type { SupabaseClient } from '@supabase/supabase-js'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { aiVisionTimeoutMs } from './defaults'
import type { AiConfig } from './types'
import {
  CIUDAD_FIELD_NAME,
  PROPIEDAD_FIELD_NAME,
} from '@/lib/contacts/lead-form'

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
  cantidad_periodos_usados: number
  promedio_bimestral_kwh: number | null
  tarifa: string | null
  /** City/municipality read off the service address, or null. */
  ciudad: string | null
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

# QUÉ BUSCAR
- Página 1: el consumo en kWh del periodo facturado ACTUAL (un solo
  número — el bimestre que se está cobrando ahora), el periodo de
  facturación (fechas), la tarifa contratada si aparece (ej. 1, 1A,
  DAC, PDBT, GDMTH), y la ciudad o municipio del domicilio del
  servicio (busca la dirección impresa — extrae SOLO la ciudad o
  municipio, nunca la calle ni el número).
- Página 2: la tabla o gráfica de "Historial de consumo". Extrae
  ÚNICAMENTE los 5 bimestres MÁS RECIENTES anteriores al periodo
  actual — si la gráfica muestra más de 5 (algunos recibos muestran
  hasta 12), IGNORA los más antiguos y toma solo los 5 más próximos al
  presente. Nunca reportes más de 5 valores en el historial: el
  consumo actual (página 1) más estos 5 bimestres (página 2) forman
  exactamente 6 periodos = 1 año de consumo, que es todo lo que se
  necesita.

# SI LA IMAGEN NO ES UN RECIBO DE CFE
Deja todos los campos numéricos en null / lista vacía y explica en
"advertencias" qué es la imagen (ej. "la imagen no es un recibo de
CFE, parece una foto de un techo").

# REGLAS
- Nunca inventes un número que no puedas leer con claridad — si algo
  no es legible, déjalo fuera y repórtalo en "advertencias".
- Nunca calcules un promedio ni una suma — solo reporta los valores
  crudos que leas. El promedio se calcula por fuera con exactitud a
  partir de lo que reportes.

# COMPACTO (importante)
Responde de la forma MÁS BREVE posible: solo los 7 campos del JSON de
abajo, nada más. NO agregues campos extra, NO transcribas la tabla
completa, NO repitas valores, NO expliques tu razonamiento. El
historial es un arreglo simple de máximo 5 números (ej. [1002, 1170,
1701, 1420, 1543]) — nunca objetos, nunca importes ni fechas dentro
del arreglo. "advertencias" es una frase corta o cadena vacía, jamás
un párrafo. Una respuesta completa cabe en menos de 200 palabras.

# FORMATO DE RESPUESTA
Responde ÚNICAMENTE con este JSON, sin texto antes ni después:
{
  "consumo_periodo_actual_kwh": <número o null>,
  "periodo_actual": "<fecha inicio - fecha fin>" o null,
  "historial_bimestres_kwh": [<máximo 5 números, los más recientes>],
  "tarifa": "<tarifa>" o null,
  "ciudad": "<ciudad o municipio del domicilio>" o null,
  "advertencias": "<texto breve, o cadena vacía si todo se leyó bien>"
}`

/** Máximo de bimestres históricos considerados (página 2). Junto con el
 *  periodo actual (página 1) da 6 periodos = 1 año de consumo — el
 *  tope es un límite duro en código, no solo una instrucción de prompt,
 *  para que un recibo con más barras en la gráfica (o un modelo que no
 *  siga la instrucción) nunca infle el promedio con datos de más de un
 *  año atrás. */
const MAX_HISTORIAL_BIMESTRES = 5

/**
 * Parse + validate the model's raw output into a ReceiptExtraction.
 * Tolerates code fences and stray prose around the JSON object.
 * Returns null when nothing parseable/valid came back.
 *
 * The average is never taken from the model's own arithmetic — it's
 * computed here, deterministically, from the raw values the model
 * reports (consumo actual + hasta 5 bimestres del historial). A model
 * summing/averaging 6 numbers by hand is exactly the kind of task LLMs
 * get subtly wrong; code doesn't.
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
  const r = obj as Record<string, unknown>

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null

  const consumoActual = num(r.consumo_periodo_actual_kwh)
  const historial = (
    Array.isArray(r.historial_bimestres_kwh)
      ? r.historial_bimestres_kwh.filter(
          (v): v is number => typeof v === 'number' && Number.isFinite(v),
        )
      : []
  ).slice(0, MAX_HISTORIAL_BIMESTRES)

  const values = [consumoActual, ...historial].filter(
    (v): v is number => v != null,
  )
  const promedio =
    values.length > 0
      ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
      : null

  return {
    consumo_periodo_actual_kwh: consumoActual,
    periodo_actual:
      typeof r.periodo_actual === 'string' ? r.periodo_actual : null,
    historial_bimestres_kwh: historial,
    cantidad_periodos_usados: values.length,
    promedio_bimestral_kwh: promedio,
    tarifa: typeof r.tarifa === 'string' ? r.tarifa : null,
    ciudad:
      typeof r.ciudad === 'string' && r.ciudad.trim() ? r.ciudad.trim() : null,
    advertencias: typeof r.advertencias === 'string' ? r.advertencias : '',
  }
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
 * Sanity bounds: a residential/commercial bimonthly average outside
 * this range is far more likely a misread than a real bill.
 */
export function isPlausibleAverage(kwh: number): boolean {
  return kwh >= 50 && kwh <= 20_000
}

/**
 * Render the extraction as the bracketed system note the auto-reply
 * model receives as a user-role message. Mirrors the date/time
 * injection pattern: context reaches the model inside the turn, the
 * cached system prompt stays untouched.
 */
export function formatReceiptNote(r: ReceiptExtraction): string {
  const lines: string[] = [
    '[NOTA DEL SISTEMA — el cliente acaba de enviar imagen(es) de su recibo de CFE. Lectura automática:',
  ]
  lines.push(
    `promedio_bimestral_kwh: ${r.promedio_bimestral_kwh ?? 'no legible'}`,
  )
  if (r.consumo_periodo_actual_kwh != null) {
    lines.push(`consumo_periodo_actual_kwh: ${r.consumo_periodo_actual_kwh}`)
  }
  if (r.historial_bimestres_kwh.length > 0) {
    lines.push(`historial_kwh: ${r.historial_bimestres_kwh.join(', ')}`)
  }
  if (r.tarifa) lines.push(`tarifa: ${r.tarifa}`)
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
    'Usa el promedio contra tu tabla de precotización si es legible y plausible; si hay advertencias o falta una página, pídela con amabilidad. Responde al cliente con naturalidad — nunca menciones esta nota ni muestres JSON.]',
  )
  return lines.join('\n')
}

/**
 * Download the customer's images from Meta and run the vision
 * extraction with the account's own key/model. Returns null on any
 * failure — the caller treats that as "no reading" and the bot follows
 * its prompt (ask again / ask for the number by text). Never throws.
 */
export async function extractReceipt(args: {
  config: Pick<AiConfig, 'provider' | 'model' | 'apiKey'>
  accessToken: string
  mediaIds: string[]
}): Promise<ReceiptExtraction | null> {
  const { config, accessToken, mediaIds } = args
  if (mediaIds.length === 0) return null

  try {
    // Receipts arrive as photos OR as the PDF CFE emails out — accept
    // both; anything else the burst dragged in (a Word doc, a random
    // download) is skipped by mime.
    const files: MediaFile[] = []
    for (const mediaId of mediaIds.slice(0, 3)) {
      const info = await getMediaUrl({ mediaId, accessToken })
      const { buffer, contentType } = await downloadMedia({
        downloadUrl: info.url,
        accessToken,
      })
      const mimeType = contentType || info.mimeType || 'image/jpeg'
      if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf') {
        continue
      }
      files.push({ base64: buffer.toString('base64'), mimeType })
    }
    if (files.length === 0) return null

    const raw =
      config.provider === 'anthropic'
        ? await visionAnthropic(config, files)
        : await visionOpenAi(config, files)
    if (!raw) return null

    return parseReceiptJson(raw)
  } catch (err) {
    // AbortSignal.timeout throws a TimeoutError — surface it distinctly
    // so "read failed" on a valid receipt is diagnosable as slowness vs.
    // a genuine provider/network error.
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    console.error(
      `[ai receipt] extraction failed${isTimeout ? ' (timeout)' : ''}:`,
      err,
    )
    return null
  }
}

interface MediaFile {
  base64: string
  mimeType: string
}

async function visionOpenAi(
  config: Pick<AiConfig, 'model' | 'apiKey'>,
  files: MediaFile[],
): Promise<string | null> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
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
      max_completion_tokens: 1500,
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
  } | null
  const choice = data?.choices?.[0]
  if (choice?.finish_reason === 'length') {
    console.error('[ai receipt] OpenAI vision truncated (hit token cap)')
  }
  return choice?.message?.content ?? null
}

async function visionAnthropic(
  config: Pick<AiConfig, 'model' | 'apiKey'>,
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
      model: config.model,
      max_tokens: 1500,
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
async function upsertField(
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
