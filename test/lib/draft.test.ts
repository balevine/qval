import { describe, expect, it } from 'vitest'
import { draftWarnings, jevQuestionCount, MANY_QUESTIONS, readDraft } from '@lib/draft.mjs'

const base = {
  scorer: 'jev',
  properties: [{ key: 'solved', label: 'Solved', type: 'boolean', instructions: 'Was it solved?' }],
  rules: 'Judge the staff, not the customer.'
}

describe('readDraft', () => {
  it('reads a well-formed draft, trimming notes, removals, and warnings', () => {
    const read = readDraft({
      ...base,
      notes: { solved: '  One yes or no question.  ', empty: '   ' },
      removed: [' the output format ', ''],
      warnings: ['The rules tie two labels together.']
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.draft.scorer).toBe('jev')
    expect(read.draft.properties).toHaveLength(1)
    expect(read.draft.notes).toEqual({ solved: 'One yes or no question.' })
    expect(read.draft.removed).toEqual(['the output format'])
    expect(read.draft.warnings).toEqual(['The rules tie two labels together.'])
  })

  it('treats notes, removed, and warnings as optional', () => {
    const read = readDraft(base)
    expect(read).toMatchObject({ ok: true, draft: { notes: {}, removed: [], warnings: [] } })
  })

  it('lists every way the envelope is wrong, rather than the first', () => {
    const read = readDraft({ scorer: 'gpt', properties: [], rules: 3, notes: [], removed: 'x', warnings: [1] })
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problems).toHaveLength(6)
    expect(read.problems.join(' ')).toContain('"scorer" must be')
    expect(read.problems.join(' ')).toContain('"properties" is empty')
  })

  it('requires a scorer, so a draft never has to be guessed at', () => {
    const { scorer: _omit, ...rest } = base
    const read = readDraft(rest)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.problems[0]).toContain('"scorer" is missing')
    expect(readDraft([base])).toEqual({ ok: false, problems: ['The draft must be a JSON object.'] })
  })
})

describe('draftWarnings', () => {
  it('names each missing Jev definition', () => {
    const warnings = draftWarnings(
      [
        { key: 'solved', label: 'Solved', type: 'boolean', description: 'd', trueDescription: 'Fixed.' },
        {
          key: 'area', label: 'Area', type: 'enum', description: 'd', options: ['billing', 'login'],
          optionDescriptions: { billing: 'Money.', biling: 'Typo.' }
        },
        { key: 'tone', label: 'Tone', type: 'score', levels: [{ label: 'Cold', description: 'Curt.' }, { label: 'Warm' }] }
      ],
      'jev'
    )
    expect(warnings).toEqual([
      { key: 'solved', message: 'This property does not say what yes and no each mean.' },
      { key: 'area', message: "The option 'login' has no definition." },
      { key: 'area', message: `"optionDescriptions" names 'biling', which is not one of the options.` },
      { key: 'tone', message: 'This property has no description.' },
      { key: 'tone', message: "The level 'Warm' has no definition." }
    ])
  })

  it('asks a multi-select for its own question per option, with what yes and no mean', () => {
    const labels = (over: Record<string, unknown>) => ({
      key: 'labels', label: 'Labels', type: 'enum', multiple: true, description: 'd', options: ['bug', 'spam'],
      optionDescriptions: { bug: 'Broken.', spam: 'Junk.' }, ...over
    })
    expect(draftWarnings([labels({})], 'jev')).toEqual([
      { key: 'labels', message: 'Every option is asked the same shared question. Give each option its own instructions.' }
    ])
    expect(
      draftWarnings(
        [labels({
          optionInstructions: { bug: 'Is it a bug?', spam: 'Is it spam?', spma: 'Typo?' },
          optionTrueDescriptions: { bug: 'A bug.', spam: 'Spam.' },
          optionFalseDescriptions: { bug: 'No bug.' }
        })],
        'jev'
      )
    ).toEqual([
      { key: 'labels', message: `"optionInstructions" names 'spma', which is not one of the options.` },
      { key: 'labels', message: "The option 'spam' does not say what yes and no each mean." }
    ])
  })

  it('names per-option questions left on a single choice, which normalization would drop', () => {
    const warnings = draftWarnings(
      [{
        key: 'area', label: 'Area', type: 'enum', description: 'd', options: ['billing', 'login'],
        optionDescriptions: { billing: 'Money.', login: 'Access.' }, optionInstructions: { billing: 'Billing?' }
      }],
      'jev'
    )
    expect(warnings).toEqual([{ key: 'area', message: '"optionInstructions" is only read on a multi-select and is ignored here.' }])
  })

  it('names Jev fields left on a claude draft, which normalization would drop silently', () => {
    const warnings = draftWarnings(
      [{ key: 'solved', label: 'Solved', type: 'boolean', description: 'd', instructions: 'Was it solved?' }],
      'claude'
    )
    expect(warnings).toEqual([{ key: 'solved', message: '"instructions" is a Jev field and is ignored under the claude scorer.' }])
  })

  it('is quiet for a fully defined draft', () => {
    expect(
      draftWarnings(
        [{ key: 'solved', label: 'Solved', type: 'boolean', description: 'd', trueDescription: 'y', falseDescription: 'n' }],
        'jev'
      )
    ).toEqual([])
    expect(draftWarnings([{ key: 'note', label: 'Note', type: 'text', description: 'd' }], 'claude')).toEqual([])
  })

  it('warns once for the whole schema when Jev would be asked too many questions', () => {
    const options = Array.from({ length: MANY_QUESTIONS }, (_, i) => `label${i}`)
    const rows = [
      { key: 'labels', label: 'Labels', type: 'enum', multiple: true, options, description: 'd',
        optionDescriptions: Object.fromEntries(options.map((o) => [o, 'x'])),
        optionInstructions: Object.fromEntries(options.map((o) => [o, `Is it ${o}?`])),
        optionTrueDescriptions: Object.fromEntries(options.map((o) => [o, 'y'])),
        optionFalseDescriptions: Object.fromEntries(options.map((o) => [o, 'n'])) },
      { key: 'solved', label: 'Solved', type: 'boolean', description: 'd', trueDescription: 'y', falseDescription: 'n' }
    ]
    expect(jevQuestionCount(rows)).toBe(MANY_QUESTIONS + 1)
    const warnings = draftWarnings(rows, 'jev')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].key).toBeNull()
    expect(warnings[0].message).toContain(`${MANY_QUESTIONS + 1} questions`)
    // Under claude the same rows are one question each, and nothing is sent to Jev.
    expect(draftWarnings(rows, 'claude').some((w) => w.key === null)).toBe(false)
  })
})
