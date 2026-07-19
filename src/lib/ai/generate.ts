import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
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
    .trim()
  return { text, handoff, leadStatus, usage }
}
