import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, LIMITS, mergeSettings, withDefaults } from './settings'
import { DEFAULT_SCHEMA } from './schema'

describe('withDefaults', () => {
  it('returns defaults for null/garbage input', () => {
    expect(withDefaults(null)).toEqual(DEFAULT_SETTINGS)
    expect(withDefaults('nope')).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps a valid provider and rejects an unknown one', () => {
    expect(withDefaults({ providerId: 'anthropic' }).providerId).toBe('anthropic')
    expect(withDefaults({ providerId: 'openai' }).providerId).toBe('ollama')
  })

  it('clamps numeric run settings into range', () => {
    expect(withDefaults({ concurrency: -3 }).concurrency).toBe(LIMITS.concurrency.min)
    expect(withDefaults({ batchSize: 9999 }).batchSize).toBe(LIMITS.batchSize.max)
  })

  it('coerces a null anthropic model and preserves a set one', () => {
    expect(withDefaults({ anthropic: { model: '' } }).anthropic.model).toBeNull()
    expect(withDefaults({ anthropic: { model: 'claude-x' } }).anthropic.model).toBe('claude-x')
  })

  it('falls back to the default schema when the stored schema is empty/invalid', () => {
    expect(withDefaults({ schema: [] }).schema).toEqual(DEFAULT_SCHEMA)
    expect(withDefaults({ schema: 'bad' }).schema).toEqual(DEFAULT_SCHEMA)
  })
})

describe('mergeSettings', () => {
  it('merges nested objects field-by-field', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { ollama: { model: 'llama3' } as never })
    expect(merged.ollama.host).toBe(DEFAULT_SETTINGS.ollama.host)
    expect(merged.ollama.model).toBe('llama3')
  })

  it('replaces the schema wholesale', () => {
    const one = [{ key: 'q', label: 'Q', type: 'boolean' as const }]
    const merged = mergeSettings(DEFAULT_SETTINGS, { schema: one })
    expect(merged.schema).toHaveLength(1)
    expect(merged.schema[0].key).toBe('q')
  })
})
