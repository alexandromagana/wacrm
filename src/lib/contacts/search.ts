/**
 * PostgREST filter values are comma/paren-delimited, and `*`/`%` are
 * its wildcards. Strip anything that could break the `.or()` grammar
 * or widen the pattern before interpolating a user's search term.
 * Leaves the characters a name, phone, or email legitimately contains.
 */
export function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();
}

/** Columns a contact search may look through. */
export type ContactSearchColumn = 'name' | 'phone' | 'email';

/**
 * The `.or()` clause that matches a contact by the things a person
 * actually remembers about one: part of the name, or part of the
 * number. Returns null when the term sanitizes down to nothing, so the
 * caller keeps its unfiltered query rather than building `%%`.
 */
export function contactSearchFilter(
  raw: string,
  columns: readonly ContactSearchColumn[] = ['name', 'phone'],
): string | null {
  const term = sanitizeSearch(raw);
  if (!term) return null;
  return columns.map((column) => `${column}.ilike.%${term}%`).join(',');
}
