// ============================================================
// GET   /api/v1/contacts/{id} — read a contact  (scope: contacts:read)
// PATCH /api/v1/contacts/{id} — update a contact (scope: contacts:write)
//
// Both are account-scoped: a contact belonging to another account
// returns 404 (never 403 — don't reveal it exists elsewhere).
// PATCH updates only the fields present in the body; pass `tags` (an
// array of tag names) to replace the contact's tags, and
// `custom_fields` (a `{ question: answer }` map) to upsert custom
// values — omitted fields are left untouched either way.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  getContactById,
  setContactTags,
  setContactCustomFields,
  parseCustomFieldsInput,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const { id } = await params;
    const contact = await getContactById(ctx.supabase, ctx.accountId, id);
    if (!contact) return fail('not_found', 'Contact not found', 404);
    return ok(contact);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    // Parse before any write so a malformed `custom_fields` is a clean
    // 400 rather than a half-applied update.
    const { customs, contactPatch } = parseCustomFieldsInput(
      body.custom_fields
    );

    // Verify the contact is in this account before mutating anything.
    const existing = await getContactById(ctx.supabase, ctx.accountId, id);
    if (!existing) return fail('not_found', 'Contact not found', 404);

    // Build a partial update from the provided scalar fields. A field
    // is updated only when its key is PRESENT (so omitted fields are
    // untouched); `null` clears it, a string sets it, and any other
    // type is a 400 rather than a silently-ignored no-op.
    const updates: Record<string, unknown> = {};
    for (const field of ['name', 'email', 'company'] as const) {
      if (!(field in body)) continue;
      const value = body[field];
      if (value === null || typeof value === 'string') {
        updates[field] = value;
      } else {
        return fail('bad_request', `'${field}' must be a string or null`, 400);
      }
    }

    // A name/email question inside `custom_fields` fills in only where
    // the body didn't name that field explicitly — an explicit `null`
    // still clears, since the key is present.
    for (const field of ['name', 'email'] as const) {
      if (field in body) continue;
      const derived = contactPatch[field];
      if (derived) updates[field] = derived;
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error } = await ctx.supabase
        .from('contacts')
        .update(updates)
        .eq('id', id)
        .eq('account_id', ctx.accountId);
      if (error) {
        console.error('[api/v1/contacts] update error:', error);
        return fail('internal', 'Failed to update contact', 500);
      }
    }

    // One lookup shared by both writes below.
    const needsAudit = Array.isArray(body.tags) || customs.length > 0;
    const auditUserId = needsAudit
      ? await resolveAuditUserId(ctx.supabase, ctx.accountId)
      : '';

    if (Array.isArray(body.tags)) {
      await setContactTags(
        ctx.supabase,
        ctx.accountId,
        auditUserId,
        id,
        body.tags.filter((t): t is string => typeof t === 'string')
      );
    }

    // Upsert: values present are set, values omitted are left alone.
    await setContactCustomFields(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      id,
      customs
    );

    const contact = await getContactById(ctx.supabase, ctx.accountId, id);
    return ok(contact);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
