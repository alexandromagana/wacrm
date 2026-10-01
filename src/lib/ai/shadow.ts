import type { SupabaseClient } from '@supabase/supabase-js'
import { generateReply } from './generate'
import {
  isReasoningEffort,
  type AiConfig,
  type ChatMessage,
  type GenerateResult,
  type ReasoningEffort,
} from './types'

// ============================================================
// Shadow runs: candidate models answering live turns, never sent.
//
// Switching the bot to another model on the strength of a replay leaves
// the turns that matter most untested: a replay of an old conversation
// has the messages but not the receipt, pricing and meter notes the bot
// was handed live, and those notes are what the quote turns run on.
//
// So with `AI_SHADOW_ARMS` set, every auto-reply turn is answered again
// by each candidate on the very same system prompt and messages, and the
// pair lands in `ai_shadow_runs` for `scripts/eval-models.ts
// shadow-report` to compare. Nothing here is sent, nothing touches the
// conversation, and nothing throws — like usage logging, it rides
// alongside the reply and can only cost tokens.
// ============================================================

export interface ShadowArm {
  model: string
  /** Null sends the code default for that model (see `chatReasoningEffort`). */
  reasoningEffort: ReasoningEffort | null
}

/**
 * Read `AI_SHADOW_ARMS`: comma-separated `model[:effort]`, e.g.
 * `gpt-6.1-sol:low,gpt-6.1-sol:medium`. `:default` or no suffix leaves
 * the effort unset. An arm with an effort this code doesn't know is
 * dropped with a warning rather than sent — a typo in an env var should
 * not cost a 400 on every turn for a week.
 */
export function parseShadowArms(raw: string | undefined): ShadowArm[] {
  if (!raw?.trim()) return []
  const arms: ShadowArm[] = []
  for (const entry of raw.split(',')) {
    const [model, effort] = entry.trim().split(':').map((p) => p.trim())
    if (!model) continue
    if (!effort || effort === 'default') {
      arms.push({ model, reasoningEffort: null })
    } else if (isReasoningEffort(effort)) {
      arms.push({ model, reasoningEffort: effort })
    } else {
      console.warn(`[ai shadow] ignoring arm "${entry.trim()}": unknown reasoning effort`)
    }
  }
  return arms
}

/** The decisions a reply carries besides its words. A disagreement here
 *  is what the comparison is about; the text is for reading it. */
export function shadowMarkers(result: GenerateResult) {
  return {
    handoff: result.handoff,
    leadStatus: result.leadStatus,
    quoteSent: result.quoteSent,
    metersExpected: result.metersExpected,
    holdQuote: result.holdQuote,
    consumptionVerdict: result.consumptionVerdict,
    packagePanels: result.packagePanels,
  }
}

export interface RunShadowArgs {
  accountId: string
  conversationId: string
  /** The account config production just answered with. Candidates use
   *  its provider and key, with their own model and effort. */
  config: AiConfig
  systemPrompt: string
  messages: ChatMessage[]
  baseline: GenerateResult
  baselineLatencyMs: number
}

/**
 * Answer the turn once per arm and record each answer next to the one
 * the customer got. Fire-and-forget: resolves when every arm has been
 * recorded or has failed, never rejects. A no-op when no arm is set.
 */
export async function runShadow(
  db: SupabaseClient,
  args: RunShadowArgs,
  arms: ShadowArm[] = parseShadowArms(process.env.AI_SHADOW_ARMS),
): Promise<void> {
  if (arms.length === 0) return

  // Copied now: the caller keeps working with its own array after this
  // returns control, and every arm must see the turn as it was answered.
  const messages = args.messages.map((m) => ({ ...m }))
  const baselineMarkers = shadowMarkers(args.baseline)

  await Promise.all(
    arms.map(async (arm) => {
      const startedAt = Date.now()
      let result: GenerateResult | null = null
      let error: string | null = null
      try {
        result = await generateReply({
          config: {
            ...args.config,
            model: arm.model,
            reasoningEffort: arm.reasoningEffort,
          },
          systemPrompt: args.systemPrompt,
          messages,
        })
      } catch (err) {
        const code = (err as { code?: unknown })?.code
        const message = err instanceof Error ? err.message : String(err)
        error = typeof code === 'string' ? `${code}: ${message}` : message
      }
      const latencyMs = Date.now() - startedAt

      try {
        const { error: insertError } = await db.from('ai_shadow_runs').insert({
          account_id: args.accountId,
          conversation_id: args.conversationId,
          model: arm.model,
          reasoning_effort: arm.reasoningEffort,
          baseline_model: args.config.model,
          baseline_text: args.baseline.text,
          baseline_markers: baselineMarkers,
          shadow_text: result?.text ?? null,
          shadow_markers: result ? shadowMarkers(result) : null,
          prompt_tokens: result?.usage?.promptTokens ?? null,
          cached_tokens: result?.usage?.cachedTokens ?? null,
          completion_tokens: result?.usage?.completionTokens ?? null,
          reasoning_tokens: result?.usage?.reasoningTokens ?? null,
          baseline_latency_ms: args.baselineLatencyMs,
          shadow_latency_ms: latencyMs,
          error,
        })
        if (insertError) {
          console.error('[ai shadow] insert failed:', insertError)
        }
      } catch (err) {
        console.error('[ai shadow] insert threw:', err)
      }
    }),
  )
}
