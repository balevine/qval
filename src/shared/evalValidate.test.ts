import { describe, expect, it } from 'vitest'
import { clampScore, validateValues, hasDrops } from './evalValidate'
import type { EvalProperty, EvalSchema } from './types'

const schema: EvalSchema = [
  { key: 'empathy', label: 'Empathy', type: 'score', min: 1, max: 5, step: 1 },
  { key: 'resolved', label: 'Resolved', type: 'boolean' },
  { key: 'category', label: 'Category', type: 'enum', options: ['bug', 'billing', 'how-to'] },
  { key: 'tags', label: 'Tags', type: 'enum', multiple: true, options: ['urgent', 'praise'] },
  { key: 'notes', label: 'Notes', type: 'text' }
]

describe('clampScore', () => {
  const p = (over: Partial<EvalProperty> = {}): EvalProperty => ({ key: 's', label: 'S', type: 'score', min: 1, max: 5, step: 1, ...over })

  it('clamps to range and snaps to step (matching what main persists)', () => {
    expect(clampScore(9, p())).toBe(5) // above max
    expect(clampScore(-3, p())).toBe(1) // below min
    expect(clampScore(3, p())).toBe(3) // in range
    expect(clampScore(3.4, p({ step: 1 }))).toBe(3) // snap to nearest integer step
    expect(clampScore(7, p({ min: 0, max: 10, step: 5 }))).toBe(5) // snap to step 5
  })
})

describe('validateValues', () => {
  it('accepts clean values with no issues', () => {
    const { values, issues } = validateValues(
      { empathy: 4, resolved: true, category: 'billing', tags: ['urgent'], notes: 'ok' },
      schema
    )
    expect(values).toEqual({ empathy: 4, resolved: true, category: 'billing', tags: ['urgent'], notes: 'ok' })
    expect(issues).toEqual([])
  })

  it('clamps an out-of-range score and records a "clamped" issue', () => {
    const { values, issues } = validateValues({ empathy: 9 }, schema)
    expect(values.empathy).toBe(5)
    expect(issues[0]).toMatchObject({ key: 'empathy', action: 'clamped', original: 9 })
  })

  it('coerces boolean/enum strings, drops an unrecognizable enum', () => {
    expect(validateValues({ resolved: 'yes' }, schema).values.resolved).toBe(true)
    expect(validateValues({ category: 'Billing' }, schema).values.category).toBe('billing') // near-miss
    const bad = validateValues({ category: 'nonsense' }, schema)
    expect(bad.values.category).toBeUndefined()
    expect(hasDrops(bad.issues)).toBe(true)
  })

  it('drops a non-numeric score (unscored, not zero)', () => {
    const { values, issues } = validateValues({ empathy: 'high' }, schema)
    expect(values.empathy).toBeUndefined()
    expect(issues[0]).toMatchObject({ key: 'empathy', action: 'dropped' })
  })

  it('multi-select: wraps a scalar, dedupes, drops invalid elements, keeps [] as scored', () => {
    expect(validateValues({ tags: 'urgent' }, schema).values.tags).toEqual(['urgent'])
    expect(validateValues({ tags: ['urgent', 'urgent', 'nope'] }, schema).values.tags).toEqual(['urgent'])
    expect(validateValues({ tags: [] }, schema).values.tags).toEqual([]) // "none apply" is a value
  })

  it('leaves an omitted property unscored with no issue', () => {
    const { values, issues } = validateValues({ empathy: 3 }, schema)
    expect('resolved' in values).toBe(false)
    expect(issues).toEqual([])
  })
})
