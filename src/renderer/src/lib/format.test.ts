import { describe, expect, it } from 'vitest'
import type { EvalProperty } from '@shared/types'
import { answerHint, formatPropertyValue, levelLabel } from './format'

const tone: EvalProperty = {
  key: 'tone',
  label: 'Tone',
  type: 'score',
  min: 0,
  max: 2,
  step: 1,
  instructions: 'How was the tone?',
  levels: [{ label: 'Poor', description: 'Curt or rude.' }, { label: 'Fine' }, { label: 'Warm', description: 'Kind.' }]
}

const plain: EvalProperty = { key: 'speed', label: 'Speed', type: 'score', min: 1, max: 5, step: 1 }

describe('levelLabel', () => {
  it('names the level a stored index points at', () => {
    expect(levelLabel(tone, 0)).toBe('Poor')
    expect(levelLabel(tone, 2)).toBe('Warm')
  })

  it('has no label for a score without levels, a fraction, or an index off the scale', () => {
    expect(levelLabel(plain, 2)).toBeNull()
    expect(levelLabel(tone, 1.5)).toBeNull()
    expect(levelLabel(tone, 3)).toBeNull()
    expect(levelLabel(tone, -1)).toBeNull()
    expect(levelLabel(tone, undefined)).toBeNull()
  })
})

describe('formatPropertyValue', () => {
  it('shows the label beside the index for a levels property', () => {
    expect(formatPropertyValue(1, tone)).toBe('1 · Fine')
  })

  it('falls back to the plain rendering everywhere else', () => {
    expect(formatPropertyValue(3, plain)).toBe('3')
    expect(formatPropertyValue(undefined, tone)).toBe('—')
    expect(formatPropertyValue(true, { key: 'r', label: 'R', type: 'boolean' })).toBe('Yes')
  })
})

describe('answerHint', () => {
  it('returns the level description, or null for a level without one', () => {
    expect(answerHint(tone, 0)).toBe('Curt or rude.')
    expect(answerHint(tone, 1)).toBeNull()
  })

  it('returns what a yes or a no means', () => {
    const p: EvalProperty = { key: 'r', label: 'R', type: 'boolean', trueDescription: 'Fixed.', falseDescription: 'Not fixed.' }
    expect(answerHint(p, true)).toBe('Fixed.')
    expect(answerHint(p, false)).toBe('Not fixed.')
    expect(answerHint(p, undefined)).toBeNull()
  })

  it('returns an option definition', () => {
    const p: EvalProperty = { key: 'c', label: 'C', type: 'enum', options: ['bug', 'billing'], optionDescriptions: { bug: 'A defect.' } }
    expect(answerHint(p, 'bug')).toBe('A defect.')
    expect(answerHint(p, 'billing')).toBeNull()
  })

  it('is null for a Claude property, which carries no definitions', () => {
    expect(answerHint(plain, 3)).toBeNull()
  })
})
