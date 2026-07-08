import { describe, expect, it } from 'vitest'
import { aggregateProperty, aggregateSession, buildStreams, compareStreams, jaccard } from './aggregate'
import { applyHumanValues, applyLlmResults, createWorkingFile } from './evalFile'
import type { ComparisonFile, EvalProperty, PropertyAggregate } from './types'

const score: EvalProperty = { key: 'empathy', label: 'E', type: 'score', min: 1, max: 5, step: 1 }
const bool: EvalProperty = { key: 'resolved', label: 'R', type: 'boolean' }
const enumP: EvalProperty = { key: 'cat', label: 'C', type: 'enum', options: ['bug', 'billing'] }
const tags: EvalProperty = { key: 'tags', label: 'T', type: 'enum', multiple: true, options: ['a', 'b', 'c'] }

const entries = (...vals: unknown[]) => vals.map((value, i) => ({ value: value as never, label: `e${i}` }))

describe('aggregateProperty', () => {
  it('score → mean + sample sd', () => {
    const a = aggregateProperty(score, entries(4, 5, 4)) as Extract<PropertyAggregate, { type: 'score' }>
    expect(a.n).toBe(3)
    expect(a.mean).toBeCloseTo(4.333, 2)
    expect(a.sd).toBeCloseTo(0.577, 2)
  })

  it('boolean → majority + agreement', () => {
    const a = aggregateProperty(bool, entries(true, true, false)) as Extract<PropertyAggregate, { type: 'boolean' }>
    expect(a.majority).toBe(true)
    expect(a.agreement).toBeCloseTo(2 / 3, 3)
    expect(a.proportionTrue).toBeCloseTo(2 / 3, 3)
  })

  it('enum → mode + agreement, and null mode on a tie', () => {
    const a = aggregateProperty(enumP, entries('bug', 'billing', 'bug')) as Extract<PropertyAggregate, { type: 'enum' }>
    expect(a.mode).toBe('bug')
    expect(a.agreement).toBeCloseTo(2 / 3, 3)
    const tie = aggregateProperty(enumP, entries('bug', 'billing')) as Extract<PropertyAggregate, { type: 'enum' }>
    expect(tie.mode).toBeNull()
  })

  it('multi-select → multi-hot distribution + majority consensus', () => {
    const a = aggregateProperty(tags, entries(['a', 'b'], ['b'], ['a', 'b', 'c'])) as Extract<PropertyAggregate, { type: 'enumSet' }>
    expect(a.distribution).toEqual({ a: 2, b: 3, c: 1 })
    expect(a.selectionRate.b).toBeCloseTo(1, 3)
    expect(a.consensus).toEqual(['a', 'b']) // rate > 0.5
  })

  it('returns null when no evaluator scored it', () => {
    expect(aggregateProperty(score, [])).toBeNull()
  })
})

describe('compareStreams', () => {
  it('score delta = human − llm', () => {
    const llm = aggregateProperty(score, entries(4))!
    const human = aggregateProperty(score, entries(5))!
    expect(compareStreams(llm, human)).toEqual({ kind: 'score', llmMean: 4, humanMean: 5, delta: 1 })
  })

  it('boolean/enum majority match', () => {
    expect(compareStreams(aggregateProperty(bool, entries(true))!, aggregateProperty(bool, entries(true))!)).toMatchObject({ agree: true })
    expect(compareStreams(aggregateProperty(enumP, entries('bug'))!, aggregateProperty(enumP, entries('billing'))!)).toMatchObject({ agree: false })
  })

  it('multi-select consensus jaccard', () => {
    const llm = aggregateProperty(tags, entries(['a', 'b']))!
    const human = aggregateProperty(tags, entries(['b']))!
    expect(compareStreams(llm, human)).toMatchObject({ kind: 'enumSet', jaccard: 0.5 })
  })
})

describe('jaccard', () => {
  it('handles overlap and the empty/empty case', () => {
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 3)
    expect(jaccard([], [])).toBe(1)
  })
})

describe('buildStreams', () => {
  const base = createWorkingFile({
    appVersion: '0.1.0',
    now: 't',
    dataset: { fingerprint: 'sha256:a', ticketCount: 1, source: null },
    config: { fingerprint: 'sha256:b', schema: [score], rules: 'r' }
  })
  const humanNamed = (name: string): ComparisonFile['evaluators'] => [
    { id: 'human', kind: 'human', name, results: [{ ticketId: 1, values: { empathy: 5 }, evaluatedAt: 't' }] }
  ]

  it('keeps evaluators from two files that share a basename (dedup keys on the unique id, not the name)', () => {
    // Two people saved their eval as "evaluation.qval.json" in different folders → same display
    // name, different paths. Both "Alex" humans must survive; keying dedup on the name would drop one.
    const a: ComparisonFile = { id: '/a/evaluation.qval.json', name: 'evaluation.qval.json', evaluators: humanNamed('Alex') }
    const b: ComparisonFile = { id: '/b/evaluation.qval.json', name: 'evaluation.qval.json', evaluators: humanNamed('Alex') }
    const streams = buildStreams(base, [a, b])
    expect(streams.filter((s) => s.kind === 'human')).toHaveLength(2)
  })

  it('collapses the same file (same id) added twice', () => {
    const a: ComparisonFile = { id: '/a/eval.qval.json', name: 'eval.qval.json', evaluators: humanNamed('Alex') }
    const streams = buildStreams(base, [a, a])
    expect(streams.filter((s) => s.kind === 'human')).toHaveLength(1)
  })
})

describe('aggregateSession', () => {
  it('pools llm and human separately across files, never combining them', () => {
    const base = createWorkingFile({
      appVersion: '0.1.0',
      now: 't',
      dataset: { fingerprint: 'sha256:a', ticketCount: 1, source: null },
      config: { fingerprint: 'sha256:b', schema: [score], rules: 'r' }
    })
    // this file: llm empathy=4, human empathy=5
    let file = applyLlmResults(base, { provider: 'anthropic', model: 'm', results: [{ ticketId: 1, values: { empathy: 4 }, evaluatedAt: 't', error: null }] })
    file = applyHumanValues(file, { name: 'Me', ticketId: 1, values: { empathy: 5 }, now: 't' })
    // a merged comparison file: llm empathy=2 (another user's model run)
    const comp: ComparisonFile = {
      id: 'c1',
      name: 'alice.qval.json',
      evaluators: [{ id: 'llm', kind: 'llm', name: 'LLM · m', results: [{ ticketId: 1, values: { empathy: 2 }, evaluatedAt: 't', error: null }] }]
    }
    const { byTicket, rollup } = aggregateSession(file, [comp], [1])
    const agg = byTicket[1]
    const llm = agg.llm.empathy as Extract<PropertyAggregate, { type: 'score' }>
    expect(llm.n).toBe(2) // two LLM evaluators pooled
    expect(llm.mean).toBe(3)
    expect((agg.human.empathy as Extract<PropertyAggregate, { type: 'score' }>).mean).toBe(5)
    expect(agg.comparison.empathy).toMatchObject({ kind: 'score', delta: 2 }) // human(5) − llm(3)
    expect(rollup.empathy).toMatchObject({ kind: 'score', nTickets: 1, meanDelta: 2 })
  })
})
