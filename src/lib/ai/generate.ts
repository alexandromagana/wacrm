import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type ConsumptionVerdict,
  type GenerateResult,
  type LeadStatus,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Lead-status marker the business prompt can ask the model to append
 * (e.g. "[ESTATUS: CALIENTE]" / "[STATUS: HOT]"). Parsed into
 * `GenerateResult.leadStatus` and always stripped from the outgoing
 * text — customers must never see it, even when the value is garbage.
 */
const STATUS_MARKER_RE = /\[\s*(?:ESTATUS|STATUS)\s*:\s*([^\]]*)\]/gi

/** Accepted labels (Spanish + English, accents ignored) → canonical status. */
const STATUS_LABELS: Record<string, LeadStatus> = {
  CALIENTE: 'hot',
  HOT: 'hot',
  TIBIO: 'warm',
  WARM: 'warm',
  FRIO: 'cold',
  COLD: 'cold',
}

/**
 * Quote marker the business prompt asks the model to append right after
 * delivering a price estimate. Stripped from the outgoing text; drives
 * the "Quote sent" tag that starts the follow-up sequence. Tolerates
 * accent/space/underscore drift and the English spelling.
 */
const QUOTE_MARKER_RE =
  /\[\s*(?:COTIZACI[OÓ]N[\s_]?ENVIADA|QUOTE[\s_]?SENT)\s*\]/gi

/**
 * Meter-count marker the business prompt asks the model to append the
 * moment the customer says how many CFE meters the property has
 * ("[MEDIDORES: 3]"). Stripped from the outgoing text; closes the
 * multi-meter gate so the bot waits for that many bills and quotes
 * their sum instead of pricing each meter as if it were the house.
 *
 * Only a small count is accepted. The marker's whole purpose is to
 * decide how long to hold a quote, and a hallucinated "[MEDIDORES: 40]"
 * would park the conversation forever waiting for bills that don't
 * exist — a silent bot is worse than a wrong quote, because nobody gets
 * notified about a reply that never comes.
 */
const METERS_MARKER_RE = /\[\s*(?:MEDIDORES|METERS)\s*:\s*(\d{1,2})\s*\]/gi

/** Above this a "count" is a misread, not a property. */
const MAX_METERS_MARKER = 6

/**
 * Hold marker: the reply is asking something and does NOT want the
 * proposal PDF going out underneath it this turn. The motive is
 * optional so a bare `[ESPERAR]` still works — a marker that only
 * counts when it is punctuated correctly is a marker that fails on the
 * turn it matters.
 */
const HOLD_MARKER_RE = /\[\s*(?:ESPERAR|WAIT|HOLD)\s*(?::\s*([^\]]*))?\]/gi

/** Longest motive we keep. It goes to a log line, not to the customer. */
const MAX_HOLD_REASON = 120

/**
 * Consumption verdict: the answer to the question a held quote is
 * waiting on. Accented and unaccented spellings both land, because the
 * model writes these in Spanish and "ATÍPICO" is the natural one.
 */
const CONSUMO_MARKER_RE = /\[\s*(?:CONSUMO|CONSUMPTION)\s*:\s*([^\]]*)\]/gi

/** Accepted labels (accents stripped) → canonical verdict. */
const CONSUMO_LABELS: Record<string, ConsumptionVerdict> = {
  NORMAL: 'normal',
  ATIPICO: 'atypical',
  ATYPICAL: 'atypical',
}

/**
 * Split the raw model output into `{ text, handoff, leadStatus, usage }`.
 * The sentinel can appear alone or trailing a partial reply; either way
 * we treat the turn as a handoff and strip the marker from any remaining
 * text. Status markers are stripped wherever they appear; the last valid
 * one wins. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  let leadStatus: LeadStatus | null = null
  let quoteSent = false
  let metersExpected: number | null = null
  let holdQuote = false
  let holdReason: string | null = null
  let consumptionVerdict: ConsumptionVerdict | null = null
  const text = raw
    .split(HANDOFF_SENTINEL)
    .join('')
    .replace(STATUS_MARKER_RE, (_marker, label: string) => {
      // Uppercase + strip diacritics so "Frío" matches FRIO.
      const key = label
        .trim()
        .toUpperCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
      leadStatus = STATUS_LABELS[key] ?? leadStatus
      return ''
    })
    .replace(QUOTE_MARKER_RE, () => {
      quoteSent = true
      return ''
    })
    .replace(METERS_MARKER_RE, (_marker, count: string) => {
      const parsed = Number(count)
      if (parsed >= 1 && parsed <= MAX_METERS_MARKER) metersExpected = parsed
      return ''
    })
    .replace(HOLD_MARKER_RE, (_marker, reason?: string) => {
      holdQuote = true
      const trimmed = reason?.trim().slice(0, MAX_HOLD_REASON) || ''
      if (trimmed) holdReason = trimmed
      return ''
    })
    .replace(CONSUMO_MARKER_RE, (_marker, label: string) => {
      const key = label
        .trim()
        .toUpperCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
      consumptionVerdict = CONSUMO_LABELS[key] ?? consumptionVerdict
      return ''
    })
    .trim()
  return {
    text,
    handoff,
    leadStatus,
    quoteSent,
    metersExpected,
    holdQuote,
    holdReason,
    consumptionVerdict,
    usage,
  }
}
