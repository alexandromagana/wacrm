// ============================================================
// Shared contact logic for the public API (v1) contact endpoints.
//
// Kept out of the route files so `GET/POST /api/v1/contacts` and
// `GET/PATCH /api/v1/contacts/{id}` share one serializer, one
// find-or-create (built on the same `findExistingContact` dedupe the
// webhook and send path use), and one tag-sync routine.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { canonicalTarget } from '@/lib/contacts/lead-form';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

/** Row select that embeds the contact's tags + custom values. */
export const CONTACT_SELECT =
  '*, contact_tags(tags(*)), contact_custom_values(value, custom_fields(field_name))';

export interface ApiContact {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  avatar_url: string | null;
  tags: { id: string; name: string; color: string }[];
  /** Custom-field values keyed by field name — the same shape callers send. */
  custom_fields: Record<string, string>;
  created_at: string;
  updated_at: string;
}

/** Thrown by the helpers below; routes map `.status`/`.message`. */
export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContactError';
    this.status = status;
  }
}

type RawTagJoin = { tags: { id: string; name: string; color: string } | null };
type RawCustomJoin = {
  value: string | null;
  custom_fields: { field_name: string } | null;
};

/** Flatten a `CONTACT_SELECT` row into the public contact shape. */
export function serializeContact(row: Record<string, unknown>): ApiContact {
  const joins = (row.contact_tags as RawTagJoin[] | undefined) ?? [];
  const customJoins =
    (row.contact_custom_values as RawCustomJoin[] | undefined) ?? [];

  const custom_fields: Record<string, string> = {};
  for (const join of customJoins) {
    // Orphaned join (field deleted mid-read) or an unset value: skip
    // rather than emit a null the caller has to special-case.
    const name = join.custom_fields?.field_name;
    if (!name || join.value == null) continue;
    custom_fields[name] = join.value;
  }

  return {
    id: row.id as string,
    phone: row.phone as string,
    name: (row.name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    company: (row.company as string | null) ?? null,
    avatar_url: (row.avatar_url as string | null) ?? null,
    tags: joins
      .map((j) => j.tags)
      .filter((t): t is NonNullable<RawTagJoin['tags']> => t != null)
      .map((t) => ({ id: t.id, name: t.name, color: t.color })),
    custom_fields,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Resolve the audit `user_id` for API-created rows — the SINGLE source
 * of truth used by every public-API write (contacts, messages,
 * broadcasts, resolve-conversation), so the same key's writes are
 * always attributed to the same human. API callers have no logged-in
 * user, so — like the inbound webhook — we attribute writes to the
 * **WhatsApp config owner** (the webhook's own convention). Contacts
 * can be created before WhatsApp is connected, so we fall back to the
 * account owner when there's no config yet.
 */
export async function resolveAuditUserId(
  db: SupabaseClient,
  accountId: string
): Promise<string> {
  const { data: config } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', accountId)
    .maybeSingle();
  const configOwner = config?.user_id as string | undefined;
  if (configOwner) return configOwner;

  const { data: account } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle();
  const owner = account?.owner_user_id as string | undefined;
  if (!owner) {
    throw new ContactError('Account owner could not be resolved', 500);
  }
  return owner;
}

export interface ContactInput {
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
}

/**
 * Find (by fuzzy phone match) or create a contact in `accountId`.
 * Returns the contact id and whether it was created. Reuses the shared
 * `findExistingContact` dedupe + unique-violation race backstop so an
 * API-created contact is indistinguishable from a webhook-created one.
 */
export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  input: ContactInput
): Promise<{ id: string; created: boolean }> {
  const sanitized = sanitizePhoneForMeta(input.phone);
  if (!isValidE164(sanitized)) {
    throw new ContactError(
      "'phone' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  const existing = await findExistingContact(db, accountId, sanitized);
  if (existing) return { id: existing.id, created: false };

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      phone: sanitized,
      name: input.name ?? sanitized,
      email: input.email ?? null,
      company: input.company ?? null,
    })
    .select('id')
    .single();

  if (error || !created) {
    // Lost a race against a concurrent create — the unique index
    // rejected the duplicate. Re-resolve to the winner.
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(db, accountId, sanitized);
      if (raced) return { id: raced.id, created: false };
    }
    console.error('[api/v1/contacts] create error:', error);
    throw new ContactError('Failed to create contact', 500);
  }

  return { id: created.id, created: true };
}

/**
 * Pick the ids for `tagNames` out of a `resolveImportTagIds` lookup.
 *
 * The map that helper returns is a lookup table over EVERY tag in the
 * account, not the resolution of this request — so its `.values()` are
 * all the account's tags. Reading it that way tagged each contact with
 * the account's entire tag set; resolve name by name instead.
 */
export function selectTagIds(
  tagNames: string[],
  tagIdByKey: Map<string, string>
): Set<string> {
  const ids = new Set<string>();
  for (const name of tagNames) {
    const id = tagIdByKey.get(name.trim().toLowerCase());
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * How `setContactTags` treats tags the contact already has and this
 * request didn't name.
 *
 * `merge` — leave them. What an intake source wants: a lead form
 *   labelling someone "Facebook Ads" must not wipe the "hot lead" a
 *   human put on them.
 * `replace` — remove them, so the contact ends up matching `tagNames`
 *   exactly. The only way to take a tag off through the API, so it
 *   stays the behaviour of the explicit update endpoint.
 */
export type TagWriteMode = 'merge' | 'replace';

/**
 * The writes needed to bring a contact's tags to `desired` under
 * `mode`. Pure, so the merge/replace rule is pinned by tests rather
 * than only exercised through a live database.
 */
export function diffContactTags(
  existing: Set<string>,
  desired: Set<string>,
  mode: TagWriteMode
): { toAdd: string[]; toRemove: string[] } {
  return {
    toAdd: [...desired].filter((id) => !existing.has(id)),
    toRemove:
      mode === 'replace' ? [...existing].filter((id) => !desired.has(id)) : [],
  };
}

/**
 * Apply `tagNames` to a contact (case-insensitive; missing tags are
 * created). `mode` decides the fate of the contact's other tags — see
 * `TagWriteMode`. Under `replace`, `[]` clears every tag; under
 * `merge`, `[]` is a no-op. Reuses `resolveImportTagIds` so API and
 * CSV-import tag handling stay consistent.
 */
export async function setContactTags(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  contactId: string,
  tagNames: string[],
  mode: TagWriteMode = 'replace'
): Promise<void> {
  const { tagIdByKey } = await resolveImportTagIds(db, {
    accountId,
    userId: auditUserId,
    tagNames,
    canCreateTags: true,
  });
  const desired = selectTagIds(tagNames, tagIdByKey);

  // Diff against the current joins rather than delete-all-then-insert:
  // a diff only touches tags that actually change, so a mid-operation
  // failure can never wipe tags that were meant to stay. Every write
  // is error-checked and surfaced as a ContactError (→ 500) instead of
  // being swallowed behind a misleading 200.
  const { data: current, error: readErr } = await db
    .from('contact_tags')
    .select('tag_id')
    .eq('contact_id', contactId);
  if (readErr) {
    throw new ContactError('Failed to read contact tags', 500);
  }
  const existing = new Set((current ?? []).map((r) => r.tag_id as string));

  const { toAdd, toRemove } = diffContactTags(existing, desired, mode);

  if (toRemove.length > 0) {
    const { error } = await db
      .from('contact_tags')
      .delete()
      .eq('contact_id', contactId)
      .in('tag_id', toRemove);
    if (error) throw new ContactError('Failed to update contact tags', 500);
  }
  if (toAdd.length > 0) {
    const { error } = await db
      .from('contact_tags')
      .insert(toAdd.map((tag_id) => ({ contact_id: contactId, tag_id })));
    if (error) throw new ContactError('Failed to update contact tags', 500);
    // Newly-added tags fire tag-driven automations, so an external sync
    // (e.g. a sheet tagging fresh leads) can start follow-up sequences —
    // same behaviour as tagging from the UI. Diff-only: re-sent tags the
    // contact already had don't re-fire. The dispatcher never throws.
    for (const tagId of toAdd) {
      await runAutomationsForTrigger({
        accountId,
        triggerType: 'tag_added',
        contactId,
        context: { tag_id: tagId },
      });
    }
  }
}

// ============================================================
// Custom fields
//
// Lead sources that aren't WhatsApp (a Facebook Lead Ads form piped
// through Make/Zapier, a landing page, a sheet sync) carry qualifying
// answers that don't fit the contact's scalar columns. `custom_fields`
// on the request body is a flat `{ question: answer }` map, routed
// through the SAME `canonicalTarget` mapping the click-to-WhatsApp
// intake uses — so "¿Estás interesada/o en opciones de financiamiento?"
// lands on the one `Interesado en financiamiento` field whether the
// lead arrived over WhatsApp or over the API, instead of forking a
// near-duplicate column per source.
// ============================================================

/** Distinct custom fields accepted in one request. */
const MAX_CUSTOM_FIELDS = 50;

export interface ParsedCustomFields {
  /** Values destined for find-or-create custom fields. */
  customs: { fieldName: string; value: string }[];
  /** Contact-row values the mapping derived (a name/email question). */
  contactPatch: { name?: string; email?: string };
}

/**
 * Coerce one caller-supplied answer to the text we store, or null to
 * skip it. Numbers/booleans are stringified (JSON senders are loose
 * about types); an array is joined, since a multi-select question
 * arrives as a list of chosen options. Objects are the one shape with
 * no sensible text form — the caller gets a 400 rather than
 * `[object Object]` silently landing on the contact.
 */
function coerceCustomValue(raw: unknown, label: string): string | null {
  if (raw == null) return null;

  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      const part = coerceCustomValue(item, label);
      if (part) parts.push(part);
    }
    return parts.length > 0 ? parts.join(', ') : null;
  }

  if (
    typeof raw === 'string' ||
    typeof raw === 'number' ||
    typeof raw === 'boolean'
  ) {
    const text = String(raw).trim();
    return text.length > 0 ? text : null;
  }

  throw new ContactError(
    `'custom_fields.${label}' must be a string, number, boolean, or array of those`,
    400
  );
}

/**
 * Validate + canonicalize a `custom_fields` body value. Throws a 400
 * `ContactError` on a bad shape. Empty/null answers are dropped rather
 * than written as blanks — a form question left unanswered should not
 * overwrite a value the contact already has.
 */
export function parseCustomFieldsInput(input: unknown): ParsedCustomFields {
  const result: ParsedCustomFields = { customs: [], contactPatch: {} };
  if (input == null) return result;

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ContactError(
      "'custom_fields' must be an object of { field name: value }",
      400
    );
  }

  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_CUSTOM_FIELDS) {
    throw new ContactError(
      `'custom_fields' accepts at most ${MAX_CUSTOM_FIELDS} entries`,
      400
    );
  }

  // Two questions can canonicalize to one field (e.g. "City" and
  // "Ciudad"); last one wins, and only one row is written.
  const byFieldName = new Map<string, string>();

  for (const [label, raw] of entries) {
    const value = coerceCustomValue(raw, label);
    if (value === null) continue;

    const target = canonicalTarget(label);
    // The contact's phone is authoritative — a form typo must never
    // fork or rewrite it.
    if (target.kind === 'skip') continue;
    if (target.kind === 'name') result.contactPatch.name = value;
    else if (target.kind === 'email') result.contactPatch.email = value;
    else byFieldName.set(target.fieldName, value);
  }

  result.customs = [...byFieldName].map(([fieldName, value]) => ({
    fieldName,
    value,
  }));
  return result;
}

/**
 * Upsert custom values onto a contact, creating any custom field the
 * account doesn't have yet (mirroring `applyLeadForm`, so both intake
 * paths converge on the same rows). Unlike the webhook's version this
 * one throws — an API caller explicitly asked for these writes, so a
 * failure must surface as a 500 rather than a misleading 200.
 */
export async function setContactCustomFields(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  contactId: string,
  customs: { fieldName: string; value: string }[]
): Promise<void> {
  if (customs.length === 0) return;

  const { data: existing, error: readErr } = await db
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId)
    .in(
      'field_name',
      customs.map((c) => c.fieldName)
    );
  if (readErr) {
    throw new ContactError('Failed to read custom fields', 500);
  }

  const idByName = new Map(
    (existing ?? []).map((f) => [f.field_name as string, f.id as string])
  );

  for (const { fieldName, value } of customs) {
    let fieldId = idByName.get(fieldName);
    if (!fieldId) {
      const { data: created, error: insErr } = await db
        .from('custom_fields')
        .insert({
          account_id: accountId,
          user_id: auditUserId,
          field_name: fieldName,
          field_type: 'text',
        })
        .select('id')
        .single();
      if (insErr || !created) {
        console.error('[api/v1/contacts] custom field create error:', insErr);
        throw new ContactError('Failed to create custom field', 500);
      }
      fieldId = created.id as string;
      idByName.set(fieldName, fieldId);
    }

    const { error: upErr } = await db
      .from('contact_custom_values')
      .upsert(
        { contact_id: contactId, custom_field_id: fieldId, value },
        { onConflict: 'contact_id,custom_field_id' }
      );
    if (upErr) {
      console.error('[api/v1/contacts] custom value upsert error:', upErr);
      throw new ContactError('Failed to save custom field value', 500);
    }
  }
}

/** Fetch + serialize a single contact scoped to the account, or null. */
export async function getContactById(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<ApiContact | null> {
  const { data, error } = await db
    .from('contacts')
    .select(CONTACT_SELECT)
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data) return null;
  return serializeContact(data as Record<string, unknown>);
}
