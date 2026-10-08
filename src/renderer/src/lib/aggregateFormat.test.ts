import { describe, expect, it } from 'vitest'
import type { EvalProperty, PropertyAggregate } from '@shared/types'
import { formatComparisonCell, formatRollup, formatStreamCell } from './aggregateFormat'

const tone: EvalProperty = {
  key: 'tone',
  label: 'Tone',
  type: 'score',
  min: 0,
  max: 2,
  step: 1,
  levels: [{ label: 'Cold' }, { label: 'Neutral' }, { label: 'Warm' }]
}
const plain: EvalProperty = { key: 'q', label: 'Q', type: 'score', min: 1, max: 5, step: 1 }

function score(values: number[]): PropertyAggregate {
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  return { type: 'score', n, mean, sd, min: Math.min(...values), max: Math.max(...values), values }
}

describe('level labels in aggregate cells', () => {
  it('shows a mean that sits on a level as just its label', () => {
    expect(formatStreamCell(score([2]), tone)).toBe('Warm')
    expect(formatStreamCell(score([1, 1]), tone)).toBe('Neutral ±0.0 (2)')
  })

  it('keeps the number beside the nearest label when evaluators split', () => {
    expect(formatStreamCell(score([1, 2, 2]), tone)).toBe('~Warm 1.7 ±0.6 (3)')
  })

  it('labels both sides of a comparison and keeps the delta numeric', () => {
    const cmp = { kind: 'score' as const, llmMean: 2, humanMean: 0, delta: 2 }
    expect(formatComparisonCell(score([2]), score([0]), cmp, tone)).toEqual({ text: 'L Warm / H Cold Δ+2.0', disagree: true })
  })

  it('leaves a score without levels as a number', () => {
    expect(formatStreamCell(score([4]), plain)).toBe('4.0')
    expect(formatStreamCell(score([3, 4]))).toBe('3.5±0.7 (2)')
  })
})

describe('categorical stream cells', () => {
  it('shows a lone evaluator as just its answer, since it always agrees with itself', () => {
    const one: PropertyAggregate = { type: 'enum', n: 1, distribution: { BUG: 1 }, mode: 'BUG', agreement: 1 }
    expect(formatStreamCell(one)).toBe('BUG')
  })

  it('shows agreement and count once there are several evaluators', () => {
    const three: PropertyAggregate = { type: 'enum', n: 3, distribution: { BUG: 2, OTHER: 1 }, mode: 'BUG', agreement: 2 / 3 }
    expect(formatStreamCell(three)).toBe('BUG 67% (3)')
  })
})

describe('dataset roll-up', () => {
  it('shows multi-select overlap as a percentage beside the raw Jaccard', () => {
    expect(formatRollup({ kind: 'enumSet', nTickets: 250, meanJaccard: 0.692 })).toBe('69% (J 0.69 | n250)')
  })
})
