import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))

import { applyQuoteSentTag, QUOTE_SENT_TAG } from './lead-status'

/**
 * In-memory fake for the two tables applyQuoteSentTag touches. Mirrors
 * the chain shapes exactly: tags → select().eq().eq().maybeSingle() and
 * insert().select().single(); contact_tags → select().eq().eq()
 * .maybeSingle() and upsert().
 */
function fakeDb(seed: {
  tags?: Record<string, unknown>[]
  links?: Record<string, unknown>[]
} = {}) {
  const tags: Record<string, unknown>[] = [...(seed.tags ?? [])]
  const links: Record<string, unknown>[] = [...(seed.links ?? [])]
  let nextId = 0

  function table(rows: Record<string, unknown>[], idPrefix: string) {
    let filters: [string, unknown][] = []
    const chain = {
      select: () => chain,
      eq: (k: string, v: unknown) => {
        filters = [...filters, [k, v]]
        return chain
      },
      maybeSingle: () => {
        const match = rows.find((r) => filters.every(([k, v]) => r[k] === v))
        filters = []
        return Promise.resolve({ data: match ?? null, error: null })
      },
      insert: (payload: Record<string, unknown>) => {
        const created = { id: `${idPrefix}-${++nextId}`, ...payload }
        rows.push(created)
        return {
          select: () => ({
            single: () => Promise.resolve({ data: created, error: null }),
          }),
        }
      },
      upsert: (payload: Record<string, unknown>) => {
        rows.push(payload)
        return Promise.resolve({ error: null })
      },
    }
    return chain
  }

  const db = {
    from: (name: string) =>
      name === 'tags' ? table(tags, 'tag') : table(links, 'link'),
  } as unknown as SupabaseClient

  return { db, tags, links }
}

const ARGS = { accountId: 'acct-1', userId: 'user-1', contactId: 'contact-1' }

beforeEach(() => {
  h.runAutomationsForTrigger.mockReset()
  h.runAutomationsForTrigger.mockResolvedValue(undefined)
})

describe('applyQuoteSentTag', () => {
  it('creates the tag, links it, and fires tag_added on a fresh contact', async () => {
    const { db, tags, links } = fakeDb()
    await applyQuoteSentTag(db, ARGS)

    expect(tags).toHaveLength(1)
    expect(tags[0]).toMatchObject({
      name: QUOTE_SENT_TAG.name,
      color: QUOTE_SENT_TAG.color,
      account_id: 'acct-1',
    })
    expect(links).toHaveLength(1)
    expect(h.runAutomationsForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: 'tag_added',
        contactId: 'contact-1',
        context: { tag_id: tags[0].id },
      }),
    )
  })

  it('reuses the existing tag row (the one ops created by hand)', async () => {
    const { db, tags } = fakeDb({
      tags: [{ id: 'tag-existente', account_id: 'acct-1', name: 'Quote sent' }],
    })
    await applyQuoteSentTag(db, ARGS)
    expect(tags).toHaveLength(1) // no duplicate row
    expect(h.runAutomationsForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ context: { tag_id: 'tag-existente' } }),
    )
  })

  it('does NOT re-fire when the contact is already tagged — a running follow-up must not restart', async () => {
    const { db, links } = fakeDb({
      tags: [{ id: 'tag-1', account_id: 'acct-1', name: 'Quote sent' }],
      links: [{ contact_id: 'contact-1', tag_id: 'tag-1' }],
    })
    await applyQuoteSentTag(db, ARGS)
    expect(links).toHaveLength(1) // unchanged
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
  })
})
