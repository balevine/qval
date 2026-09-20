import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, withDefaults } from '@lib/settings.mjs'
import { DEFAULT_SCHEMA } from '@lib/schema.mjs'

describe('withDefaults', () => {
  it('returns defaults for null/garbage input', () => {
    expect(withDefaults(null)).toEqual(DEFAULT_SETTINGS)
    expect(withDefaults('nope')).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps the string fields it recognizes and nulls the ones of the wrong type', () => {
    expect(withDefaults({ evaluatorName: 'Ada' }).evaluatorName).toBe('Ada')
    expect(withDefaults({ lastDatasetPath: '/tmp/tickets.json' }).lastDatasetPath).toBe('/tmp/tickets.json')
    expect(withDefaults({ lastDatasetPath: 7 }).lastDatasetPath).toBeNull()
  })

  it('drops settings an older release wrote (providers, and the file-dialog paths)', () => {
    const stale = {
      providerId: 'anthropic',
      ollama: { host: 'h' },
      concurrency: 8,
      defaultDir: '/tmp/evals',
      lastWorkingPath: '/tmp/x.qval.json',
      evaluatorName: 'Ada'
    }
    expect(withDefaults(stale)).toEqual({ ...DEFAULT_SETTINGS, evaluatorName: 'Ada' })
  })

  it('falls back to the default schema when the stored schema is empty/invalid', () => {
    expect(withDefaults({ schema: [] }).schema).toEqual(DEFAULT_SCHEMA)
    expect(withDefaults({ schema: 'bad' }).schema).toEqual(DEFAULT_SCHEMA)
  })
})

describe('mergeSettings', () => {
  it('leaves untouched fields alone', () => {
    const current = { ...DEFAULT_SETTINGS, evaluatorName: 'Ada', lastDatasetPath: '/tmp/tickets.json' }
    const merged = mergeSettings(current, { rules: 'be kind' })
    expect(merged.rules).toBe('be kind')
    expect(merged.evaluatorName).toBe('Ada')
    expect(merged.lastDatasetPath).toBe('/tmp/tickets.json')
  })

  it('replaces the schema wholesale', () => {
    const one = [{ key: 'q', label: 'Q', type: 'boolean' as const }]
    const merged = mergeSettings(DEFAULT_SETTINGS, { schema: one })
    expect(merged.schema).toHaveLength(1)
    expect(merged.schema[0].key).toBe('q')
  })
})
