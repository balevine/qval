import { describe, expect, it } from 'vitest'
import {
  applyHumanValues,
  applyLlmResults,
  CLAUDE_CODE_PROVIDER,
  configLocked,
  createWorkingFile,
  evaluatedCount,
  humanEvaluatedCount,
  lockedLlmProvider,
  looksLikeEvalFile,
  mergeResults,
  needsAttention,
  normalizeEvalFile,
  ownResults
} from '@lib/evalFile.mjs'
import type { EvalResult } from './types'
import { DEFAULT_SCHEMA } from '@lib/schema.mjs'
import { DEFAULT_RULES } from '@lib/rules.mjs'
import type { EvalFile } from './types'

const working = (): EvalFile =>
  createWorkingFile({
    appVersion: '0.1.0',
    now: '2026-07-02T00:00:00.000Z',
    dataset: { fingerprint: 'sha256:aaa', ticketCount: 3, source: { provider: 'anthropic', model: 'm' } },
    config: { fingerprint: 'sha256:bbb', schema: DEFAULT_SCHEMA, rules: DEFAULT_RULES }
  })

describe('createWorkingFile', () => {
  it('creates an empty evaluator list with the snapshot meta', () => {
    const f = working()
    expect(f.meta.app).toBe('qval')
    expect(f.meta.dataset.ticketCount).toBe(3)
    expect(f.meta.createdAt).toBe(f.meta.updatedAt)
    expect(f.evaluators).toEqual([])
  })
})

describe('looksLikeEvalFile', () => {
  it('recognizes a qval file by meta.app or an evaluators array', () => {
    expect(looksLikeEvalFile({ meta: { app: 'qval' } })).toBe(true)
    expect(looksLikeEvalFile({ evaluators: [] })).toBe(true)
    expect(looksLikeEvalFile({ tickets: [] })).toBe(false)
    expect(looksLikeEvalFile(null)).toBe(false)
  })
})

describe('normalizeEvalFile', () => {
  it('round-trips a freshly created working file', () => {
    const f = working()
    expect(normalizeEvalFile(JSON.parse(JSON.stringify(f)))).toEqual(f)
  })

  it('rejects non-qval JSON', () => {
    expect(normalizeEvalFile({ tickets: [] })).toBeNull()
    expect(normalizeEvalFile({ meta: { app: 'other' }, evaluators: [] })).toBeNull()
  })

  it('keeps evaluators and drops duplicate ticketIds within one evaluator', () => {
    const f = working()
    const raw = {
      ...f,
      evaluators: [
        {
          id: 'llm',
          kind: 'llm',
          name: 'LLM',
          model: 'm',
          results: [
            { ticketId: 1, values: { empathy: 4 }, evaluatedAt: 't', error: null },
            { ticketId: 1, values: { empathy: 5 }, evaluatedAt: 't2' },
            { ticketId: 2, values: { resolved: true }, evaluatedAt: 't3' }
          ]
        }
      ]
    }
    const norm = normalizeEvalFile(raw)!
    expect(norm.evaluators).toHaveLength(1)
    expect(norm.evaluators[0].results.map((r) => r.ticketId)).toEqual([1, 2])
    expect(norm.evaluators[0].results[0].values.empathy).toBe(4) // first wins
  })

  it('normalizes the config schema/rules snapshot', () => {
    const f = working()
    const raw = { ...f, meta: { ...f.meta, config: { ...f.meta.config, schema: [], rules: 42 } } }
    const norm = normalizeEvalFile(raw)!
    expect(norm.meta.config.schema).toEqual(DEFAULT_SCHEMA) // [] → default
    expect(typeof norm.meta.config.rules).toBe('string')
  })
})

describe('applyLlmResults', () => {
  const result = (ticketId: number, empathy: number): EvalResult => ({
    ticketId,
    values: { empathy },
    evaluatedAt: 't',
    error: null
  })

  it('creates the llm evaluator and upserts results by ticketId', () => {
    const f0 = working()
    const f1 = applyLlmResults(f0, { provider: 'anthropic', model: 'm', results: [result(1, 4), result(2, 5)] })
    const llm = f1.evaluators.find((e) => e.id === 'llm')!
    expect(llm.kind).toBe('llm')
    expect(llm.name).toBe('LLM · m')
    expect(llm.results.map((r) => r.ticketId)).toEqual([1, 2])

    // A re-run of just ticket 1 replaces it and preserves ticket 2.
    const f2 = applyLlmResults(f1, { provider: 'anthropic', model: 'm', results: [result(1, 2)] })
    const llm2 = f2.evaluators.find((e) => e.id === 'llm')!
    expect(llm2.results.find((r) => r.ticketId === 1)!.values.empathy).toBe(2)
    expect(llm2.results.find((r) => r.ticketId === 2)!.values.empathy).toBe(5)
  })
})

describe('applyHumanValues', () => {
  const now = '2026-07-03T00:00:00.000Z'

  it('creates the human evaluator and upserts one ticket at a time', () => {
    const f0 = working()
    const f1 = applyHumanValues(f0, { name: 'Brian', ticketId: 1, values: { resolved: true }, now })
    const human = f1.evaluators.find((e) => e.id === 'human')!
    expect(human.kind).toBe('human')
    expect(human.name).toBe('Brian')
    expect(human.results).toEqual([{ ticketId: 1, values: { resolved: true }, evaluatedAt: now }])

    const f2 = applyHumanValues(f1, { name: 'Brian', ticketId: 2, values: { resolved: false }, now })
    expect(ownResults(f2, 'human').map((r) => r.ticketId)).toEqual([1, 2])
  })

  it('replaces a ticket’s values wholesale and removes it when cleared to empty', () => {
    let f = working()
    f = applyHumanValues(f, { name: 'B', ticketId: 1, values: { resolved: true }, now })
    f = applyHumanValues(f, { name: 'B', ticketId: 1, values: { resolved: false }, now }) // replace
    expect(ownResults(f, 'human')[0].values.resolved).toBe(false)
    f = applyHumanValues(f, { name: 'B', ticketId: 1, values: {}, now }) // clear → removed
    expect(ownResults(f, 'human')).toEqual([])
  })

  it('does not disturb the llm evaluator', () => {
    let f = applyLlmResults(working(), { provider: 'anthropic', model: 'm', results: [{ ticketId: 1, values: { empathy: 4 }, evaluatedAt: now, error: null }] })
    f = applyHumanValues(f, { name: 'B', ticketId: 1, values: { resolved: true }, now })
    expect(ownResults(f, 'llm')).toHaveLength(1)
    expect(humanEvaluatedCount(f)).toBe(1)
  })
})

describe('evaluatedCount', () => {
  it('counts only results with ≥1 non-empty value — ignores errored and all-dropped (same for both streams)', () => {
    const f = applyLlmResults(working(), {
      provider: 'ollama',
      model: 'm',
      results: [
        { ticketId: 1, values: { empathy: 4 }, evaluatedAt: 't', error: null }, // scored → counts
        { ticketId: 2, values: {}, evaluatedAt: 't', error: 'boom' }, // errored → not counted
        { ticketId: 3, values: {}, issues: [{ key: 'empathy', action: 'dropped' }], evaluatedAt: 't', error: null } // all-dropped, no error → not counted
      ]
    })
    expect(evaluatedCount(f, 'llm')).toBe(1)
    expect(evaluatedCount(f, 'human')).toBe(0)
  })
})

describe('needsAttention', () => {
  it('flags a missing, errored, or dropped-value result — and only those', () => {
    expect(needsAttention(undefined)).toBe(true) // never scored
    expect(needsAttention({ ticketId: 1, values: {}, evaluatedAt: 't', error: 'boom' })).toBe(true)
    expect(
      needsAttention({ ticketId: 1, values: { empathy: 4 }, evaluatedAt: 't', issues: [{ key: 'cat', action: 'dropped' }] })
    ).toBe(true)
    expect(needsAttention({ ticketId: 1, values: { empathy: 4 }, evaluatedAt: 't', error: null })).toBe(false)
    // a coerced/clamped value is resolved, not attention-worthy
    expect(
      needsAttention({ ticketId: 1, values: { empathy: 4 }, evaluatedAt: 't', issues: [{ key: 'empathy', action: 'clamped' }] })
    ).toBe(false)
  })
})

describe('config lock + model pin (spec §3/§4)', () => {
  const now = '2026-07-03T00:00:00.000Z'
  const llmResult = (ticketId: number, over: Partial<EvalResult> = {}): EvalResult => ({
    ticketId,
    values: { empathy: 4 },
    evaluatedAt: now,
    error: null,
    ...over
  })

  it('an empty working file is unlocked (schema still editable during setup)', () => {
    const f = working()
    expect(configLocked(f)).toBe(false)
    expect(lockedLlmProvider(f)).toBeNull()
    expect(configLocked(null)).toBe(false)
    expect(configLocked(undefined)).toBe(false)
  })

  it('an error-only / empty-values result does not lock', () => {
    const f = applyLlmResults(working(), {
      provider: CLAUDE_CODE_PROVIDER,
      model: 'Opus 5',
      results: [llmResult(1, { values: {}, error: 'boom' })]
    })
    expect(configLocked(f)).toBe(false)
    expect(lockedLlmProvider(f)).toBeNull() // an unscored run pins nothing, so a retry may switch models
  })

  it('a scored human value locks the config but pins no model', () => {
    const f = applyHumanValues(working(), { name: 'B', ticketId: 1, values: { resolved: true }, now })
    expect(configLocked(f)).toBe(true)
    expect(lockedLlmProvider(f)).toBeNull()
  })

  it('a scored LLM value locks the config and pins the producing provider/model', () => {
    const f = applyLlmResults(working(), { provider: CLAUDE_CODE_PROVIDER, model: 'Opus 5', results: [llmResult(1)] })
    expect(configLocked(f)).toBe(true)
    expect(lockedLlmProvider(f)).toEqual({ provider: CLAUDE_CODE_PROVIDER, model: 'Opus 5' })
  })

  it('pins whatever an older release recorded, so its files still read', () => {
    const f = applyLlmResults(working(), { provider: 'ollama', model: 'llama3.1', results: [llmResult(1)] })
    expect(lockedLlmProvider(f)).toEqual({ provider: 'ollama', model: 'llama3.1' })
  })
})

describe('mergeResults', () => {
  it('fills a value dropped in the first attempt from the retry (cleaner wins)', () => {
    const first: EvalResult = { ticketId: 1, values: { empathy: 4 }, evaluatedAt: 't', error: null, issues: [{ key: 'category', action: 'dropped' }] }
    const retry: EvalResult = { ticketId: 1, values: { empathy: 2, category: 'bug' }, evaluatedAt: 't2', error: null }
    const merged = mergeResults(first, retry)
    expect(merged.values).toEqual({ empathy: 4, category: 'bug' }) // first wins where both present; retry fills the gap
    expect(merged.issues).toBeUndefined()
  })

  it('clears a ticket-level error when the retry produced values', () => {
    const first: EvalResult = { ticketId: 1, values: {}, evaluatedAt: 't', error: 'omitted' }
    const retry: EvalResult = { ticketId: 1, values: { empathy: 3 }, evaluatedAt: 't2', error: null }
    expect(mergeResults(first, retry).error).toBeNull()
  })

  it('returns the first attempt untouched when there was no retry', () => {
    const first: EvalResult = { ticketId: 1, values: { empathy: 4 }, evaluatedAt: 't', error: null }
    expect(mergeResults(first, undefined)).toBe(first)
  })
})
