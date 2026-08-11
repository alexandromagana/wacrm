import { AiError, type ProviderResult } from '../types'
import { aiMaxOutputTokens } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

/**
 * Reasoning-capable model families (o1/o3/o4-mini, the gpt-5.x line
 * including the Sol/Terra/Luna tiers). These default to
 * `reasoning_effort: "medium"` on Chat Completions when the param is
 * omitted, which can leak the model's own deliberation into the visible
 * reply instead of the customer-facing text (e.g. a reasoning model
 * answering "no hagas nada, solo es pregunta" instead of writing the
 * reply). This bot never uses function tools and only wants direct
 * text output, so reasoning buys nothing — we turn it off explicitly.
 * Sending `reasoning_effort` to a non-reasoning model (gpt-4o and
 * earlier) is a 400, so this must stay opt-in by model name.
 */
const REASONING_MODEL_RE = /^(gpt-5|o1|o3|o4)(\b|[.-])/i

interface OpenAiResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_completion_tokens: aiMaxOutputTokens(),
        ...(REASONING_MODEL_RE.test(model) ? { reasoning_effort: 'none' } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    // A reasoning model that spends the whole output budget thinking
    // returns finish_reason "length" with empty content. Name that
    // cause in the error — it's indistinguishable from a generic empty
    // completion otherwise, and the fix (raise the budget) is not
    // obvious from "empty response".
    const reasoning = data?.usage?.completion_tokens_details?.reasoning_tokens
    const budgetExhausted =
      data?.choices?.[0]?.finish_reason === 'length' || (reasoning ?? 0) > 0
    throw new AiError(
      budgetExhausted
        ? `OpenAI returned an empty response: the output budget (${aiMaxOutputTokens()}) was consumed before any text was produced` +
          `${reasoning ? ` (${reasoning} reasoning tokens)` : ''}. ` +
          'This model reasons before replying — raise AI_MAX_OUTPUT_TOKENS or use a non-reasoning model.'
        : 'OpenAI returned an empty response.',
      { code: 'empty_response' },
    )
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}
