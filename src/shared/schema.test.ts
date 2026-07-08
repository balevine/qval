import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCHEMA,
  allowsMultiple,
  blankProperty,
  normalizeSchema,
  propertyErrors,
  toCamelKey
} from './schema'

describe('allowsMultiple', () => {
  it('permits enum/score but not boolean/text', () => {
    expect(allowsMultiple('enum')).toBe(true)
    expect(allowsMultiple('score')).toBe(true)
    expect(allowsMultiple('boolean')).toBe(false)
    expect(allowsMultiple('text')).toBe(false)
  })
})

describe('normalizeSchema', () => {
  it('falls back to the default schema for non-arrays / empties', () => {
    expect(normalizeSchema(null)).toEqual(DEFAULT_SCHEMA)
    expect(normalizeSchema([])).toEqual(DEFAULT_SCHEMA)
  })

  it('derives a camelCase key from the label when missing', () => {
    const [p] = normalizeSchema([{ label: 'Follow Up', type: 'boolean' }])
    expect(p.key).toBe('followUp')
  })

  it('orders score min/max and defaults the step', () => {
    const [p] = normalizeSchema([{ label: 'S', type: 'score', min: 5, max: 1 }])
    expect(p.min).toBe(1)
    expect(p.max).toBe(5)
    expect(p.step).toBe(1)
  })

  it('drops an enum with fewer than two options', () => {
    expect(normalizeSchema([{ label: 'C', type: 'enum', options: ['only'] }])).toEqual(DEFAULT_SCHEMA)
  })

  it('de-duplicates enum options and keeps multiple only where allowed', () => {
    const [enumProp] = normalizeSchema([
      { label: 'Tags', type: 'enum', multiple: true, options: ['a', 'a', 'b'] }
    ])
    expect(enumProp.options).toEqual(['a', 'b'])
    expect(enumProp.multiple).toBe(true)

    const [boolProp] = normalizeSchema([{ label: 'Yes', type: 'boolean', multiple: true }])
    expect(boolProp.multiple).toBeUndefined() // boolean can't be multi-valued
  })

  it('drops properties with duplicate keys', () => {
    const out = normalizeSchema([
      { key: 'dup', label: 'One', type: 'boolean' },
      { key: 'dup', label: 'Two', type: 'boolean' }
    ])
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe('One')
  })
})

describe('toCamelKey', () => {
  it('camelCases labels and strips punctuation', () => {
    expect(toCamelKey('Follow Up')).toBe('followUp')
    expect(toCamelKey('  Churn-Risk! ')).toBe('churnRisk')
    expect(toCamelKey('')).toBe('')
  })
})

describe('blankProperty', () => {
  it('seeds score defaults and two empty enum options', () => {
    expect(blankProperty('score')).toMatchObject({ type: 'score', min: 1, max: 5, step: 1 })
    expect(blankProperty('enum').options).toEqual(['', ''])
  })
})

describe('propertyErrors', () => {
  const ok = { key: 'empathy', label: 'Empathy', type: 'score' as const, min: 1, max: 5, step: 1 }

  it('returns no errors for a valid row', () => {
    expect(propertyErrors(ok, [])).toEqual([])
  })

  it('flags missing label, bad key, and duplicate key', () => {
    expect(propertyErrors({ ...ok, label: '' }, [])).toContain('Label is required.')
    expect(propertyErrors({ ...ok, key: 'Bad Key' }, []).some((e) => /camelCase/.test(e))).toBe(true)
    expect(propertyErrors(ok, ['empathy']).some((e) => /already used/.test(e))).toBe(true)
  })

  it('flags score min>=max and enum with <2 options', () => {
    expect(propertyErrors({ ...ok, min: 5, max: 5 }, []).some((e) => /min < max/.test(e))).toBe(true)
    expect(
      propertyErrors({ key: 'c', label: 'C', type: 'enum', options: ['only'] }, []).some((e) =>
        /at least 2/.test(e)
      )
    ).toBe(true)
  })
})
