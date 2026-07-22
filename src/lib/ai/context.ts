import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
}

/**
 * Media rows carry no reusable text, but the model MUST still know they
 * happened: filtering them out entirely made the bot deny receiving a
 * receipt the customer had just sent ("no he recibido tu recibo" with
 * the PDF sitting right there). Each non-text message becomes a short
 * bracketed placeholder — enough for the model to acknowledge it and
 * follow its prompt rules (ask for a readable copy, ask for text
 * instead of a voice note, etc.).
 */
function toContent(m: DbMessage): string | null {
  const text = m.content_text?.trim() || ''
  switch (m.content_type) {
    case 'text':
      return text || null
    case 'image':
      return text ? `[Imagen adjunta: ${text}]` : '[Imagen adjunta]'
    case 'document':
      return text ? `[Documento adjunto: ${text}]` : '[Documento adjunto]'
    case 'audio':
      return '[Nota de voz — sin transcripción disponible]'
    case 'video':
      return text ? `[Video adjunto: ${text}]` : '[Video adjunto]'
    case 'location':
      return '[Ubicación compartida]'
    default:
      // template / interactive rows store meaningful text (body or the
      // tapped option title) — pass it through when present.
      return text || null
  }
}

/**
 * Fetch the last N messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages are included
 * as bracketed placeholders (see `toContent`).
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  const out: ChatMessage[] = []
  for (const m of rows) {
    const content = toContent(m)
    if (!content) continue
    out.push({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content,
    })
  }
  return out
}
