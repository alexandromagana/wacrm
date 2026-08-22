import type { ChatMessage } from './types'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

/** Prefix of the synthetic notes the dispatcher pushes as user-role
 *  turns (clock, receipt readings, meter bookkeeping). They look exactly
 *  like customer text by the time they reach here, and quoting one as
 *  "the last customer message" tells the agent picking up the thread
 *  nothing about the customer. */
const SYSTEM_NOTE_PREFIX = '[NOTA DEL SISTEMA'

/** Why the bot stopped. Each maps to one sentence in the note so the
 *  agent knows whether the conversation stalled, ran out of budget, or
 *  the model itself asked for a person. */
export type HandoffReason =
  | 'cap_reached'
  | 'model_requested'
  | 'meter_gate'
  | 'no_reply'

const REASON_TEXT: Record<HandoffReason, string> = {
  cap_reached: 'It ran out of replies for this conversation.',
  model_requested: 'It asked for a person to continue.',
  meter_gate:
    "It couldn't confirm how many meters the property has, so a quote would have covered only part of it.",
  no_reply: 'It produced no reply to send.',
}

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. It asked for a person to
 *    continue. Last customer message: “can I speak to a manager about
 *    my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
  reason: HandoffReason
}): string {
  const { messages, replyCount, reason } = args

  const lastCustomer = [...messages]
    .reverse()
    .find(
      (m) =>
        m.role === 'user' &&
        m.content.trim() &&
        !m.content.trimStart().startsWith(SYSTEM_NOTE_PREFIX),
    )

  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`

  const base = `🤖 AI agent handed off ${replies}. ${REASON_TEXT[reason]}`

  if (!lastCustomer) return base

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN)
  return `${base} Last customer message: “${quote}”`
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}
