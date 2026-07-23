import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Lead-ad questionnaire intake.
//
// 80%+ of conversations open with the click-to-WhatsApp lead form:
//
//   ¡Hola! Completé el formulario y me gustaría obtener más información…
//   Phone number: +52…
//   City: Cancún
//   ¿Estás interesada/o en opciones de financiamiento?: Si
//   Full name: Arley Ramirez
//   …
//
// Parse those `key: value` lines out of the first message and land
// them on the contact automatically — name/email onto the contact row,
// everything else into find-or-create custom fields — so the roster is
// populated before a human ever opens the thread.
// ============================================================

export interface LeadFormPair {
  key: string
  value: string
}

/** A line qualifies as a form pair when it has a short-ish label, a
 *  colon, and a non-empty value. Requiring 3+ pairs keeps ordinary
 *  prose ("ojo: dos cosas…") from being mistaken for a form. */
const PAIR_RE = /^([^:\n]{3,80}?):\s*(.+)$/

export function parseLeadForm(text: string): LeadFormPair[] | null {
  const pairs: LeadFormPair[] = []
  for (const line of text.split('\n')) {
    const m = line.trim().match(PAIR_RE)
    if (!m) continue
    const key = m[1].trim()
    const value = m[2].trim()
    if (key && value) pairs.push({ key, value })
  }
  return pairs.length >= 3 ? pairs : null
}

type CanonicalTarget =
  | { kind: 'name' }
  | { kind: 'email' }
  | { kind: 'skip' }
  | { kind: 'custom'; fieldName: string }

/** Strip accents + punctuation so "¿…financiamiento?" matches. */
function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[¿?¡!]/g, '')
    .trim()
}

// Stable custom-field names, exported so other intake sources (the
// receipt reader's tarifa/ciudad extraction) write to the exact same
// columns instead of risking a near-duplicate field from a casing/
// wording drift.
export const CIUDAD_FIELD_NAME = 'Ciudad'
export const FINANCIAMIENTO_FIELD_NAME = 'Interesado en financiamiento'
export const TECHO_FIELD_NAME = 'Tamaño de techo'
export const PROPIEDAD_FIELD_NAME = 'Tipo de propiedad'
export const LUZ_FIELD_NAME = 'Pago promedio de luz'

/**
 * Map a form question to where it lands. Known questions get short,
 * stable custom-field names (the ad's wording can drift without
 * spawning new columns); unknown questions fall through to a custom
 * field named after the question itself, so nothing is ever dropped.
 */
export function canonicalTarget(key: string): CanonicalTarget {
  const k = normalizeKey(key)
  // The WhatsApp sender phone is authoritative — a typo here must not
  // fork the contact.
  if (k.includes('phone') || k.includes('telefono')) return { kind: 'skip' }
  if (k === 'full name' || k.includes('nombre')) return { kind: 'name' }
  if (k.includes('email') || k.includes('correo')) return { kind: 'email' }
  if (k === 'city' || k.includes('ciudad')) {
    return { kind: 'custom', fieldName: CIUDAD_FIELD_NAME }
  }
  if (k.includes('financiamiento')) {
    return { kind: 'custom', fieldName: FINANCIAMIENTO_FIELD_NAME }
  }
  if (k.includes('techo')) {
    return { kind: 'custom', fieldName: TECHO_FIELD_NAME }
  }
  if (k.includes('propiedad')) {
    return { kind: 'custom', fieldName: PROPIEDAD_FIELD_NAME }
  }
  if (k.includes('electricidad') || k.includes('luz')) {
    return { kind: 'custom', fieldName: LUZ_FIELD_NAME }
  }
  return { kind: 'custom', fieldName: key.replace(/[¿?]/g, '').slice(0, 60) }
}

/**
 * Land parsed form pairs on the contact: name/email update the contact
 * row (the form's full name beats the WhatsApp nickname), the rest
 * upsert into per-account find-or-create custom fields. Never throws —
 * intake is a side effect and must not break message processing.
 */
export async function applyLeadForm(
  db: SupabaseClient,
  args: {
    accountId: string
    /** Audit owner for freshly-created custom_fields rows. */
    userId: string
    contactId: string
    pairs: LeadFormPair[]
  },
): Promise<void> {
  const { accountId, userId, contactId, pairs } = args
  try {
    const contactPatch: Record<string, string> = {}
    const customs: { fieldName: string; value: string }[] = []

    for (const { key, value } of pairs) {
      const target = canonicalTarget(key)
      if (target.kind === 'skip') continue
      if (target.kind === 'name') contactPatch.name = value
      else if (target.kind === 'email') contactPatch.email = value
      else customs.push({ fieldName: target.fieldName, value })
    }

    if (Object.keys(contactPatch).length > 0) {
      const { error } = await db
        .from('contacts')
        .update(contactPatch)
        .eq('id', contactId)
        .eq('account_id', accountId)
      if (error) throw error
    }

    if (customs.length === 0) return

    const names = customs.map((c) => c.fieldName)
    const { data: existing, error: readErr } = await db
      .from('custom_fields')
      .select('id, field_name')
      .eq('account_id', accountId)
      .in('field_name', names)
    if (readErr) throw readErr

    const idByName = new Map(
      (existing ?? []).map((f) => [f.field_name as string, f.id as string]),
    )
    for (const c of customs) {
      let fieldId = idByName.get(c.fieldName)
      if (!fieldId) {
        const { data: created, error: insErr } = await db
          .from('custom_fields')
          .insert({
            account_id: accountId,
            user_id: userId,
            field_name: c.fieldName,
            field_type: 'text',
          })
          .select('id')
          .single()
        if (insErr) throw insErr
        fieldId = created.id as string
        idByName.set(c.fieldName, fieldId)
      }
      const { error: upErr } = await db.from('contact_custom_values').upsert(
        {
          contact_id: contactId,
          custom_field_id: fieldId,
          value: c.value,
        },
        { onConflict: 'contact_id,custom_field_id' },
      )
      if (upErr) throw upErr
    }
  } catch (err) {
    console.error('[lead-form] intake failed:', err)
  }
}
