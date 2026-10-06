import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCHEMA,
  allowsMultiple,
  blankProperty,
  jevOptionText,
  jevQuestionText,
  normalizeSchema,
  OPTION_QUESTION_FIELDS,
  normalizeScorer,
  parseSchemaFile,
  propertyErrors,
  schemaErrors,
  schemaFile,
  toCamelKey
} from '@lib/schema.mjs'
import type { EvalProperty } from '@shared/types'

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

describe('scorer', () => {
  it('reads anything unknown as claude', () => {
    expect(normalizeScorer('jev')).toBe('jev')
    expect(normalizeScorer('claude')).toBe('claude')
    expect(normalizeScorer(undefined)).toBe('claude')
    expect(normalizeScorer('gpt')).toBe('claude')
  })
})

describe('parseSchemaFile', () => {
  const props = [{ key: 'q', label: 'Q', type: 'boolean' }]

  it('reads a bare array as the claude scorer', () => {
    expect(parseSchemaFile(props)).toEqual({ scorer: 'claude', properties: props })
  })

  it('reads the wrapped form, defaulting a missing scorer to claude', () => {
    expect(parseSchemaFile({ scorer: 'jev', properties: props })).toEqual({ scorer: 'jev', properties: props })
    expect(parseSchemaFile({ properties: props })).toEqual({ scorer: 'claude', properties: props })
  })

  it('passes an unknown scorer through so a strict caller can report it', () => {
    expect(parseSchemaFile({ scorer: 'gpt', properties: props })?.scorer).toBe('gpt')
  })

  it('returns null for anything else', () => {
    expect(parseSchemaFile(null)).toBeNull()
    expect(parseSchemaFile({ scorer: 'jev' })).toBeNull()
    expect(parseSchemaFile('nope')).toBeNull()
  })

  it('round-trips what schemaFile writes', () => {
    const written = schemaFile('jev', DEFAULT_SCHEMA)
    expect(parseSchemaFile(JSON.parse(JSON.stringify(written)))).toEqual({ scorer: 'jev', properties: DEFAULT_SCHEMA })
  })
})

describe('normalizeSchema under jev', () => {
  const jevRaw = [
    {
      key: 'tone', label: 'Tone', type: 'score', min: 1, max: 9, step: 3, instructions: '  How warm?  ',
      levels: [{ label: 'Cold', description: 'Curt.' }, { label: '' }, { label: 'Neutral' }, { label: 'Warm', description: ' ' }]
    },
    { key: 'solved', label: 'Solved', type: 'boolean', instructions: 'Solved?', trueDescription: 'Yes.', falseDescription: 'No.' },
    {
      key: 'kind', label: 'Kind', type: 'enum', options: ['bug', 'billing'], instructions: 'Which kind?',
      optionDescriptions: { billing: 'Money.', bug: 'Broken.', stale: 'Gone.' }
    },
    {
      key: 'labels', label: 'Labels', type: 'enum', multiple: true, options: ['bug', 'spam'], instructions: 'Which labels?',
      optionInstructions: { spam: ' Is it spam? ', bug: 'Is it a bug?', stale: 'Gone?' },
      optionTrueDescriptions: { bug: 'A bug.', spam: ' ' },
      optionFalseDescriptions: {}
    }
  ]

  it('keeps per-option questions on a multi-select only, keyed by its options in order', () => {
    const labels = normalizeSchema(jevRaw, 'jev')[3]
    expect(labels.optionInstructions).toEqual({ bug: 'Is it a bug?', spam: 'Is it spam?' })
    expect(Object.keys(labels.optionInstructions!)).toEqual(['bug', 'spam'])
    // An empty entry is left off, and a map left with no entries is left off entirely.
    expect(labels.optionTrueDescriptions).toEqual({ bug: 'A bug.' })
    expect(labels).not.toHaveProperty('optionFalseDescriptions')
    // A single choice asks one question, so it has no per-option questions to keep.
    const [single] = normalizeSchema([{ ...jevRaw[3], multiple: false }], 'jev')
    for (const k of OPTION_QUESTION_FIELDS) expect(single).not.toHaveProperty(k)
  })

  it('keeps the jev fields and takes a score\'s bounds from its levels', () => {
    const [tone, solved, kind] = normalizeSchema(jevRaw, 'jev')
    expect(tone).toMatchObject({ min: 0, max: 2, step: 1, instructions: 'How warm?' })
    // An unlabeled level is dropped, an empty description is left off.
    expect(tone.levels).toEqual([{ label: 'Cold', description: 'Curt.' }, { label: 'Neutral' }, { label: 'Warm' }])
    expect(solved).toMatchObject({ trueDescription: 'Yes.', falseDescription: 'No.' })
    // Only descriptions of options that exist survive, in option order.
    expect(kind.optionDescriptions).toEqual({ bug: 'Broken.', billing: 'Money.' })
    expect(Object.keys(kind.optionDescriptions!)).toEqual(['bug', 'billing'])
  })

  it('strips every jev field under claude, so a claude schema is exactly what it always was', () => {
    const out = normalizeSchema(jevRaw)
    for (const p of out) {
      for (const k of ['instructions', 'trueDescription', 'falseDescription', 'optionDescriptions', ...OPTION_QUESTION_FIELDS, 'levels']) {
        expect(p).not.toHaveProperty(k)
      }
    }
    expect(out[0]).toMatchObject({ min: 1, max: 9, step: 3 })
  })

  it('leaves a score without enough levels on its own bounds', () => {
    const [p] = normalizeSchema([{ key: 's', label: 'S', type: 'score', min: 1, max: 5, step: 1, levels: [{ label: 'One' }] }], 'jev')
    expect(p.levels).toBeUndefined()
    expect(p).toMatchObject({ min: 1, max: 5, step: 1 })
  })
})

describe('jev validation', () => {
  const bool = (over: Partial<EvalProperty> = {}): EvalProperty => ({
    key: 'solved', label: 'Solved', type: 'boolean', instructions: 'Was it solved?', ...over
  })
  const levels = [{ label: 'Low' }, { label: 'High' }]

  it('accepts a well-formed jev property', () => {
    expect(propertyErrors(bool(), [], 'jev')).toEqual([])
    expect(
      propertyErrors({ key: 't', label: 'T', type: 'score', min: 0, max: 1, step: 1, levels, instructions: 'How?' }, [], 'jev')
    ).toEqual([])
  })

  it('refuses text and multi-valued scores', () => {
    expect(propertyErrors({ key: 'n', label: 'N', type: 'text', instructions: 'Notes?' }, [], 'jev')).toContain(
      'Jev cannot score text properties.'
    )
    expect(
      propertyErrors({ key: 's', label: 'S', type: 'score', multiple: true, min: 0, max: 1, step: 1, levels, instructions: 'x' }, [], 'jev')
    ).toContain('Jev cannot score a multi-valued score.')
  })

  it('refuses a Jev score with more than ten levels', () => {
    const levels = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `L${i}` }))
    const score: EvalProperty = { key: 's', label: 'S', type: 'score', min: 0, max: 1, step: 1, instructions: 'x' }
    expect(propertyErrors({ ...score, levels: levels(10) }, [], 'jev')).toEqual([])
    expect(propertyErrors({ ...score, levels: levels(11) }, [], 'jev')).toContain('A Jev score takes at most 10 levels.')
  })

  it('requires instructions and, on a score, at least two labeled levels', () => {
    expect(propertyErrors(bool({ instructions: '  ' }), [], 'jev')).toContain('Jev needs instructions (the question itself).')
    const score: EvalProperty = { key: 's', label: 'S', type: 'score', min: 1, max: 5, step: 1, instructions: 'x' }
    expect(propertyErrors(score, [], 'jev')).toContain('A Jev score needs at least 2 levels.')
    expect(propertyErrors({ ...score, levels: [{ label: 'a' }, { label: ' ' }] }, [], 'jev')).toContain('Every level needs a label.')
  })

  it('leaves claude validation unchanged', () => {
    expect(propertyErrors({ key: 'n', label: 'N', type: 'text' }, [])).toEqual([])
    expect(propertyErrors({ key: 's', label: 'S', type: 'score', multiple: true, min: 1, max: 5, step: 1 }, [], 'claude')).toEqual([])
  })

  it('refuses two properties that ask Jev the same text', () => {
    const errors = schemaErrors([bool({ key: 'a' }), bool({ key: 'b' }), bool({ key: 'c', description: 'Count a workaround.' })], 'jev')
    expect(errors[0].some((e) => /same question/.test(e))).toBe(true)
    expect(errors[1].some((e) => /same question/.test(e))).toBe(true)
    // The description is part of the question, so this one differs.
    expect(errors[2]).toEqual([])
    // Claude never sees the question text alone, so it has no such rule.
    expect(schemaErrors([bool({ key: 'a' }), bool({ key: 'b' })], 'claude')).toEqual([[], []])
  })

  it('compiles the question from instructions then description', () => {
    expect(jevQuestionText(bool({ description: ' More. ' }))).toBe('Was it solved?\n\nMore.')
    expect(jevQuestionText(bool())).toBe('Was it solved?')
  })

  it('reports duplicate keys across the schema the same way propertyErrors does', () => {
    expect(schemaErrors([bool(), bool({ instructions: 'Other?' })], 'jev')[1].some((e) => /already used/.test(e))).toBe(true)
  })

  describe('a multi-select asking each option its own question', () => {
    const labels = (over: Partial<EvalProperty> = {}): EvalProperty => ({
      key: 'labels', label: 'Labels', type: 'enum', multiple: true, options: ['bug', 'spam'],
      optionInstructions: { bug: 'Is it a bug?', spam: 'Is it spam?' },
      optionDescriptions: { bug: 'Something broken.' },
      ...over
    })

    it('needs no shared instructions, since they are never sent', () => {
      expect(propertyErrors(labels(), [], 'jev')).toEqual([])
      expect(propertyErrors(labels({ optionInstructions: undefined }), [], 'jev')).toContain(
        'Jev needs instructions (the question itself).'
      )
    })

    it('refuses instructions on only some options', () => {
      expect(propertyErrors(labels({ optionInstructions: { bug: 'Is it a bug?' } }), [], 'jev')).toEqual([
        'Give every option its own instructions, or none of them. Missing: spam.'
      ])
    })

    it('compiles an option from its own instructions then its definition', () => {
      expect(jevOptionText(labels(), 'bug')).toBe('Is it a bug?\n\nSomething broken.')
      expect(jevOptionText(labels(), 'spam')).toBe('Is it spam?')
      // Without its own instructions an option is the shared question with the option named.
      const shared = labels({ optionInstructions: undefined, instructions: 'Which labels?' })
      expect(jevOptionText(shared, 'bug')).toBe('Which labels?\n\nOption: bug')
    })

    it('refuses two options, or an option and a property, that ask Jev the same text', () => {
      const twins = labels({ optionInstructions: { bug: 'Is it spam?', spam: 'Is it spam?' }, optionDescriptions: {} })
      expect(schemaErrors([twins], 'jev')[0]).toEqual([
        "The option 'bug' asks Jev the same question as another (instructions plus description).",
        "The option 'spam' asks Jev the same question as another (instructions plus description)."
      ])
      const errors = schemaErrors([labels(), bool({ key: 'spam', instructions: 'Is it spam?' })], 'jev')
      expect(errors[0]).toEqual(["The option 'spam' asks Jev the same question as another (instructions plus description)."])
      expect(errors[1].some((e) => /same question/.test(e))).toBe(true)
    })
  })
})
