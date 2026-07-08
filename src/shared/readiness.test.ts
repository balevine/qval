import { describe, expect, it } from 'vitest'
import { evaluationReadiness } from './readiness'
import { DEFAULT_SETTINGS } from './settings'
import type { Settings } from './types'

const s = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over })

describe('evaluationReadiness', () => {
  it('ollama needs a model', () => {
    expect(evaluationReadiness(s({ providerId: 'ollama', ollama: { host: 'h', model: '' } }), false).ready).toBe(false)
    expect(evaluationReadiness(s({ providerId: 'ollama', ollama: { host: 'h', model: 'llama3' } }), false).ready).toBe(true)
  })

  it('anthropic needs a key and a model', () => {
    const base = s({ providerId: 'anthropic', anthropic: { model: 'claude-x' } })
    expect(evaluationReadiness(base, false).message).toMatch(/api key/i)
    expect(evaluationReadiness(s({ providerId: 'anthropic', anthropic: { model: null } }), true).message).toMatch(/model/i)
    expect(evaluationReadiness(base, true).ready).toBe(true)
  })
})
