import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

import { loadAiConfig } from './config'

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
}

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })
})

describe('loadAiConfig visionModel fallback', () => {
  const load = (row: Record<string, unknown>) =>
    loadAiConfig(dbReturning(row), 'acct', { requireActive: false })

  it('falls back to the chat model when unset — existing accounts keep today’s behaviour', async () => {
    expect((await load({ ...ROW, vision_model: null }))!.visionModel).toBe(
      'gpt-x',
    )
    // Column missing entirely (row from before the migration ran).
    expect((await load(ROW))!.visionModel).toBe('gpt-x')
    // Blank / whitespace from the settings form is not a model name.
    expect((await load({ ...ROW, vision_model: '   ' }))!.visionModel).toBe(
      'gpt-x',
    )
  })

  it('uses the dedicated vision model when set, leaving the chat model alone', async () => {
    const config = (await load({ ...ROW, vision_model: 'gpt-vision-cheap' }))!
    expect(config.visionModel).toBe('gpt-vision-cheap')
    expect(config.model).toBe('gpt-x')
  })
})
