import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES, normalizeRules } from '@lib/rules.mjs'

describe('normalizeRules', () => {
  it('passes a string through untouched, including its whitespace', () => {
    // The rules go into the prompt verbatim, and the fingerprint trims rather than normalizing
    // here, so this must not quietly reshape what the user wrote.
    expect(normalizeRules('  Be fair.\n\n  Then be fair again.  ')).toBe('  Be fair.\n\n  Then be fair again.  ')
    expect(normalizeRules('')).toBe('')
  })

  it('falls back to the default for anything that is not a string', () => {
    for (const raw of [undefined, null, 42, {}, ['a']]) expect(normalizeRules(raw)).toBe(DEFAULT_RULES)
  })
})
