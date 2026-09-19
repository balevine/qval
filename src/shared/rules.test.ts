import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES, normalizeRules } from '@lib/rules.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

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

describe('DEFAULT_RULES', () => {
  it('matches the scaffolded EVAL_RULES.md template', async () => {
    // Two copies of the starter rules, and the rules feed the config fingerprint: drift here means
    // a scaffolded run and a browser-seeded run produce files that will not merge.
    const template = await fs.readFile(
      join(repoRoot, 'plugin/skills/evaluate-tickets/templates/EVAL_RULES.md'),
      'utf8'
    )
    expect(template.trim()).toBe(DEFAULT_RULES.trim())
  })
})
