import { describe, expect, it } from 'vitest'
import { evaluationReadiness } from './readiness'
import { DEFAULT_SETTINGS } from './settings'
import { applyLlmResults, CLAUDE_CODE_PROVIDER, createWorkingFile } from './evalFile'
import { DEFAULT_RULES } from './rules'
import { DEFAULT_SCHEMA } from './schema'
import type { Settings } from './types'

const s = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over })

const scoredBy = (provider: string) =>
  applyLlmResults(
    createWorkingFile({
      appVersion: '0.1.0',
      now: 't',
      dataset: { fingerprint: 'sha256:a', ticketCount: 1, source: null },
      config: { fingerprint: 'sha256:b', schema: DEFAULT_SCHEMA, rules: DEFAULT_RULES }
    }),
    { provider, model: 'm', results: [{ ticketId: 1, values: { empathy: 4 }, evaluatedAt: 't', error: null }] }
  )

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

  it('a skill-produced file is never ready, however well the provider is configured', () => {
    const ready = s({ providerId: 'ollama', ollama: { host: 'h', model: 'llama3' } })
    const r = evaluationReadiness(ready, true, scoredBy(CLAUDE_CODE_PROVIDER))
    expect(r.ready).toBe(false)
    expect(r.message).toMatch(/Claude Code skill/)
    // An app-produced file falls through to the ordinary provider checks.
    expect(evaluationReadiness(ready, true, scoredBy('ollama')).ready).toBe(true)
  })
})
