import { describe, expect, it } from 'vitest'
import { flagValue, parseArgs } from '@lib/args.mjs'

describe('parseArgs', () => {
  it('reads --flag value pairs and bare arguments', () => {
    expect(parseArgs(['tickets.json', '--model', 'Opus 5'])).toEqual({
      _: ['tickets.json'],
      model: 'Opus 5'
    })
  })

  it('treats a flag followed by another flag, or by nothing, as boolean true', () => {
    expect(parseArgs(['--write', '--preview'])).toEqual({ _: [], write: true, preview: true })
    expect(parseArgs(['--check'])).toEqual({ _: [], check: true })
  })

  it('lets a bare flag swallow a positional that follows it', () => {
    // Only another flag or the end of argv terminates a bare flag. It is why `qval serve <file>`
    // takes its positional first: `serve --no-open tickets.json` would read as --no-open=tickets.json.
    expect(parseArgs(['--check', 'tickets.json'])).toEqual({ _: [], check: 'tickets.json' })
  })

  it('takes a negative number as a value, not as a flag', () => {
    expect(parseArgs(['--round', '-1'])).toEqual({ _: [], round: '-1' })
  })
})

describe('flagValue', () => {
  it('returns the string, or null for absent / bare / blank', () => {
    const args = parseArgs(['--model', 'Opus 5', '--check', '--name', '   '])
    expect(flagValue(args, 'model')).toBe('Opus 5')
    expect(flagValue(args, 'check')).toBeNull() // bare flag is not the literal "true"
    expect(flagValue(args, 'name')).toBeNull() // whitespace is not a value
    expect(flagValue(args, 'missing')).toBeNull()
  })

  it('trims, so a quoted value with padding still resolves', () => {
    expect(flagValue(parseArgs(['--eval-file', ' run.qval.json ']), 'eval-file')).toBe('run.qval.json')
  })
})
