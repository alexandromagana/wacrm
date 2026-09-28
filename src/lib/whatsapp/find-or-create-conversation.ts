// ============================================================
// Find or create a contact's conversation.
//
// One conversation per (account, contact): the unique index from
// migration 036 guarantees it, and this helper is the write path that
// respects it — oldest-first lookup, insert, and a re-resolve when a
// concurrent writer wins the race. Shared by the public API
// (resolve-conversation.ts, which starts from a phone number) and the
// automation engine's template sender (which already has the contact).
//
// It lives apart from resolve-conversation.ts because that module
// imports the public-API contact helpers, which import the automation
// engine; the engine's sender importing it back would close a cycle.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { SendMessageError } from '@/lib/whatsapp/send-message';

/**
 * Find (oldest-first) or create the single conversation for
 * `(accountId, contactId)`. Handles the unique-index race the same way
 * the inbound webhook does: on a 23505 from a concurrent create,
 * re-resolve the winning row rather than failing the send.
 */
export async function findOrCreateConversationRow(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  ownerUserId: string
): Promise<string> {
  const { data: existing, error: findErr } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findErr) {
    console.error(
      '[find-or-create-conversation] conversation lookup error:',
      findErr
    );
    throw new SendMessageError('db_error', 'Failed to resolve conversation', 500);
  }

  if (existing && existing.length > 0) {
    return existing[0].id;
  }

  const { data: newConv, error: convErr } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
    })
    .select('id')
    .single();

  if (convErr || !newConv) {
    if (isUniqueViolation(convErr)) {
      const { data: raced } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return raced[0].id;
      }
    }
    console.error(
      '[find-or-create-conversation] conversation create error:',
      convErr
    );
    throw new SendMessageError('db_error', 'Failed to create conversation', 500);
  }

  return newConv.id;
}
