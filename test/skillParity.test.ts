/**
 * Parity between `src/shared` and the Claude Code skill's dependency-free ports in
 * `.claude/skills/evaluate-tickets/lib/`.
 *
 * The skill runs on bare `node` with no `npm install` (and the folder is copyable to
 * `~/.claude/skills`), so the pure logic is duplicated rather than imported. That duplication is
 * only safe if the two implementations agree: a CLI-produced `*.qval.json` and an app-produced one
 * of the same dataset and config must carry identical fingerprints or they silently stop merging.
 * Every case below runs both implementations over the same input and compares the results.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { datasetFingerprint, configFingerprint } from '@shared/fingerprint'
import { normalizeSchema, propertyErrors, DEFAULT_SCHEMA } from '@shared/schema'
import { DEFAULT_RULES } from '@shared/rules'
import { validateValues } from '@shared/evalValidate'
import { compilePrompt, SYSTEM_PROMPT } from '@shared/promptCompiler'
import { parseTicketsFile } from '@shared/validate'
import { normalizeEvalFile, needsAttention, isScoredResult } from '@shared/evalFile'
import { mergeResults } from '../src/main/evaluation/orchestrator'
import type { EvalProperty, EvalResult, EvalSchema, Ticket } from '@shared/types'

import * as portFingerprint from '../.claude/skills/evaluate-tickets/lib/fingerprint.mjs'
import * as portSchema from '../.claude/skills/evaluate-tickets/lib/schema.mjs'
import * as portRules from '../.claude/skills/evaluate-tickets/lib/rules.mjs'
import * as portValidate from '../.claude/skills/evaluate-tickets/lib/evalValidate.mjs'
import * as portPrompt from '../.claude/skills/evaluate-tickets/lib/promptCompiler.mjs'
import * as portTickets from '../.claude/skills/evaluate-tickets/lib/tickets.mjs'
import * as portEvalFile from '../.claude/skills/evaluate-tickets/lib/evalFile.mjs'

// --- Fixtures ----------------------------------------------------------------

const TICKETS: Ticket[] = [
  {
    id: 1,
    subject: "Can't log in after password reset",
    status: 'open',
    messages: [
      {
        from: { name: 'Sarah Kim', email: 'sarah.kim@example.com' },
        body: 'I reset my password but still get "invalid credentials".',
        isStaff: false,
        createdAt: '2026-06-28T09:14:00.000Z'
      },
      {
        from: { name: 'Mike Rodriguez', email: 'mike.rodriguez@company.biz' },
        body: 'Cleared the stale session on our end. Try once more.',
        isStaff: true,
        createdAt: '2026-06-28T15:42:00.000Z'
      }
    ]
  },
  {
    id: 2,
    subject: 'Double charged for June',
    status: 'solved',
    messages: [
      {
        from: { name: 'Alex Doe', email: 'alex@example.com' },
        body: 'My card was charged twice.',
        isStaff: false,
        createdAt: '2026-06-29T11:00:00.000Z'
      }
    ]
  }
]

const SCHEMA: EvalSchema = [
  { key: 'empathy', label: 'Empathy', type: 'score', min: 1, max: 5, step: 1, description: 'Warmth of the reply.' },
  { key: 'resolved', label: 'Resolved', type: 'boolean' },
  { key: 'severity', label: 'Severity', type: 'enum', options: ['low', 'high'] },
  { key: 'categories', label: 'Categories', type: 'enum', multiple: true, options: ['bug', 'billing'] },
  { key: 'note', label: 'Note', type: 'text' }
]

const RULES = 'Score the staff handling, not the customer.\n\nBe consistent across tickets.'

/** A deep clone that also drops `undefined`s (what a file round-trip would produce). */
const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

// --- Constants ---------------------------------------------------------------

describe('shared constants', () => {
  it('DEFAULT_SCHEMA and DEFAULT_RULES are copied verbatim (both feed the config fingerprint)', () => {
    expect(portSchema.DEFAULT_SCHEMA).toEqual(DEFAULT_SCHEMA)
    expect(portRules.DEFAULT_RULES).toBe(DEFAULT_RULES)
    expect(portPrompt.SYSTEM_PROMPT).toBe(SYSTEM_PROMPT)
  })

  it('the `init` templates carry the default config exactly', async () => {
    // `init` copies these two files verbatim, so a hand-edit here would move the config
    // fingerprint of every scaffolded run away from the app's default config.
    const dir = resolve(__dirname, '../.claude/skills/evaluate-tickets/templates')
    const rules = readFileSync(resolve(dir, 'EVAL_RULES.md'), 'utf8')
    const schema = JSON.parse(readFileSync(resolve(dir, 'EVAL_SCHEMA.json'), 'utf8'))
    expect(rules.trim()).toBe(DEFAULT_RULES.trim())
    expect(schema).toEqual(DEFAULT_SCHEMA)
    expect(await configFingerprint(schema, rules)).toBe(await configFingerprint(DEFAULT_SCHEMA, DEFAULT_RULES))
  })
})

// --- datasetFingerprint ------------------------------------------------------

describe('datasetFingerprint parity', () => {
  it('agrees with the app over a case table', async () => {
    const cases: { name: string; tickets: Ticket[] }[] = [
      { name: 'baseline', tickets: TICKETS },
      { name: 'empty', tickets: [] },
      { name: 'no messages', tickets: [{ ...TICKETS[0], messages: [] }] },
      { name: 'reordered tickets', tickets: [TICKETS[1], TICKETS[0]] }
    ]
    for (const c of cases) {
      expect(portFingerprint.datasetFingerprint(c.tickets), c.name).toBe(await datasetFingerprint(c.tickets))
    }
  })

  it('ignores re-serialization and formatting, but not content', async () => {
    // Same content, different key order + a stray field a re-export might add.
    const reformatted = TICKETS.map((t) => ({
      messages: t.messages.map((m) => ({ createdAt: m.createdAt, isStaff: m.isStaff, body: m.body, from: m.from })),
      status: t.status,
      subject: t.subject,
      id: t.id,
      extra: 'ignored'
    })) as unknown as Ticket[]
    const base = portFingerprint.datasetFingerprint(TICKETS)
    expect(base).toBe(await datasetFingerprint(TICKETS))
    expect(portFingerprint.datasetFingerprint(reformatted)).toBe(base)
    expect(await datasetFingerprint(reformatted)).toBe(base)

    const changed = roundTrip(TICKETS)
    changed[0].messages[0].body += '!'
    expect(portFingerprint.datasetFingerprint(changed)).not.toBe(base)
    expect(await datasetFingerprint(changed)).not.toBe(base)
  })
})

// --- configFingerprint -------------------------------------------------------

describe('configFingerprint parity', () => {
  it('agrees with the app over a case table', async () => {
    const cases: { name: string; schema: unknown; rules: string }[] = [
      { name: 'baseline', schema: SCHEMA, rules: RULES },
      { name: 'default config', schema: DEFAULT_SCHEMA, rules: DEFAULT_RULES },
      { name: 'schema with an invalid row', schema: [...SCHEMA, { key: 'x', label: '', type: 'score' }], rules: RULES },
      { name: 'non-array schema', schema: 'nope', rules: RULES },
      { name: 'empty rules', schema: SCHEMA, rules: '' }
    ]
    for (const c of cases) {
      expect(portFingerprint.configFingerprint(c.schema, c.rules), c.name).toBe(
        await configFingerprint(c.schema as EvalSchema, c.rules)
      )
    }
  })

  it('normalizes rules whitespace out, but a schema reorder changes the hash', async () => {
    const base = portFingerprint.configFingerprint(SCHEMA, RULES)
    expect(base).toBe(await configFingerprint(SCHEMA, RULES))

    const padded = `\n\n  ${RULES}  \n`
    expect(portFingerprint.configFingerprint(SCHEMA, padded)).toBe(base)
    expect(await configFingerprint(SCHEMA, padded)).toBe(base)

    // Internal whitespace is content, not formatting, so it must still change the hash.
    const rewrapped = RULES.replace('\n\n', ' ')
    expect(portFingerprint.configFingerprint(SCHEMA, rewrapped)).not.toBe(base)

    const reordered = [SCHEMA[1], SCHEMA[0], ...SCHEMA.slice(2)]
    expect(portFingerprint.configFingerprint(reordered, RULES)).not.toBe(base)
    expect(await configFingerprint(reordered, RULES)).not.toBe(base)
    expect(portFingerprint.configFingerprint(reordered, RULES)).toBe(await configFingerprint(reordered, RULES))
  })
})

// --- normalizeSchema ---------------------------------------------------------

describe('normalizeSchema parity', () => {
  const cases: { name: string; raw: unknown }[] = [
    { name: 'valid schema', raw: SCHEMA },
    { name: 'not an array', raw: { key: 'a' } },
    { name: 'empty array falls back to the default', raw: [] },
    { name: 'all rows invalid falls back to the default', raw: [{ type: 'nope' }, null, 'x'] },
    { name: 'missing label', raw: [{ key: 'a', type: 'score' }, ...SCHEMA] },
    { name: 'key derived from the label', raw: [{ label: 'Follow Up', type: 'boolean' }] },
    { name: 'duplicate keys deduped', raw: [SCHEMA[1], { ...SCHEMA[1], label: 'Resolved Again' }] },
    { name: 'enum with one option rejected', raw: [{ key: 'e', label: 'E', type: 'enum', options: ['only'] }, SCHEMA[1]] },
    { name: 'enum options trimmed + deduped', raw: [{ key: 'e', label: 'E', type: 'enum', options: [' a ', 'a', '', 'b'] }] },
    { name: 'multiple on a boolean is dropped', raw: [{ ...SCHEMA[1], multiple: true }] },
    { name: 'score bounds swapped + bad step', raw: [{ key: 's', label: 'S', type: 'score', min: 9, max: 2, step: 0 }] },
    { name: 'score fields defaulted', raw: [{ key: 's', label: 'S', type: 'score' }] },
    { name: 'blank description dropped', raw: [{ key: 't', label: 'T', type: 'text', description: '   ' }] }
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(portSchema.normalizeSchema(c.raw)).toEqual(normalizeSchema(c.raw))
    })
  }

  it('propertyErrors produces the same messages (they are printed by `config --check`)', () => {
    const rows: EvalProperty[] = [
      SCHEMA[0],
      { key: '', label: '', type: 'score' },
      { key: 'Not Camel', label: 'Bad Key', type: 'text' },
      { key: 'resolved', label: 'Dupe', type: 'boolean' },
      { key: 'b', label: 'B', type: 'boolean', multiple: true },
      { key: 's', label: 'S', type: 'score', min: 5, max: 1, step: 0 },
      { key: 'e', label: 'E', type: 'enum', options: [' a ', 'a'] }
    ]
    for (const row of rows) {
      expect(portSchema.propertyErrors(row, ['resolved']), row.key).toEqual(propertyErrors(row, ['resolved']))
    }
  })

  it('the shared expectations hold in both (not just "equally wrong")', () => {
    expect(portSchema.normalizeSchema([])).toEqual(DEFAULT_SCHEMA)
    expect(portSchema.normalizeSchema([SCHEMA[1], { ...SCHEMA[1], label: 'Again' }])).toHaveLength(1)
    expect(portSchema.normalizeSchema([{ key: 'e', label: 'E', type: 'enum', options: ['one'] }])).toEqual(DEFAULT_SCHEMA)
    expect(portSchema.toCamelKey('Follow Up')).toBe('followUp')
  })
})

// --- validateValues ----------------------------------------------------------

describe('validateValues parity', () => {
  const cases: { name: string; raw: unknown }[] = [
    { name: 'all valid', raw: { empathy: 4, resolved: true, severity: 'high', categories: ['bug'], note: 'ok' } },
    { name: 'score clamped above max', raw: { empathy: 9 } },
    { name: 'score snapped to step', raw: { empathy: 3.4 } },
    { name: 'numeric string coerced', raw: { empathy: '2' } },
    { name: 'score dropped', raw: { empathy: 'very good' } },
    { name: 'boolean from yes/no', raw: { resolved: 'yes' } },
    { name: 'boolean from a number', raw: { resolved: 0 } },
    { name: 'boolean dropped', raw: { resolved: 'maybe' } },
    { name: 'enum case-corrected', raw: { severity: ' HIGH ' } },
    { name: 'enum dropped', raw: { severity: 'critical' } },
    { name: 'multiple deduped with a bad element', raw: { categories: ['bug', 'bug', 'nope'] } },
    { name: 'multiple scalar wrapped into an array', raw: { categories: 'billing' } },
    { name: 'multiple empty array is a scored value', raw: { categories: [] } },
    { name: 'multiple null becomes []', raw: { categories: null } },
    { name: 'text stringified from a number', raw: { note: 12 } },
    { name: 'text dropped from an object', raw: { note: { a: 1 } } },
    { name: 'unknown keys ignored', raw: { nope: 1, resolved: true } },
    { name: 'omitted properties produce no issue', raw: {} },
    { name: 'not an object at all', raw: 'garbage' },
    { name: 'null', raw: null }
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(portValidate.validateValues(c.raw, SCHEMA)).toEqual(validateValues(c.raw, SCHEMA))
    })
  }

  it('the shared expectations hold in both', () => {
    expect(portValidate.validateValues({ empathy: 9 }, SCHEMA)).toEqual({
      values: { empathy: 5 },
      issues: [{ key: 'empathy', action: 'clamped', original: 9 }]
    })
    expect(portValidate.validateValues({ categories: [] }, SCHEMA).values).toEqual({ categories: [] })
    expect(portValidate.validateValues({}, SCHEMA)).toEqual({ values: {}, issues: [] })
    expect(portValidate.hasDrops([{ key: 'a', action: 'dropped' }])).toBe(true)
    expect(portValidate.hasDrops([{ key: 'a', action: 'clamped' }])).toBe(false)
    expect(portValidate.clampScore(3.4, SCHEMA[0])).toBe(validateValues({ empathy: 3.4 }, SCHEMA).values.empathy)
  })
})

// --- compilePrompt -----------------------------------------------------------

describe('compilePrompt parity', () => {
  const cases: { name: string; rules: string; schema: EvalSchema; tickets: Ticket[] }[] = [
    { name: 'baseline', rules: RULES, schema: SCHEMA, tickets: TICKETS },
    { name: 'single ticket', rules: RULES, schema: SCHEMA, tickets: [TICKETS[1]] },
    { name: 'default config', rules: DEFAULT_RULES, schema: DEFAULT_SCHEMA, tickets: TICKETS },
    { name: 'no tickets', rules: RULES, schema: SCHEMA, tickets: [] },
    {
      name: 'fractional step + multi-score',
      rules: '  padded rules  ',
      schema: [{ key: 'tone', label: 'Tone', type: 'score', min: 0, max: 1, step: 0.5, multiple: true }],
      tickets: TICKETS
    }
  ]

  for (const c of cases) {
    it(c.name, () => {
      const expected = compilePrompt({ rules: c.rules, schema: c.schema, tickets: c.tickets })
      const actual = portPrompt.compilePrompt({ rules: c.rules, schema: c.schema, tickets: c.tickets })
      // Full string equality, including the output contract and the example shape.
      expect(actual.system).toBe(expected.system)
      expect(actual.staticPrefix).toBe(expected.staticPrefix)
      expect(actual.dynamicSuffix).toBe(expected.dynamicSuffix)
      expect(actual.full).toBe(expected.full)
    })
  }
})

// --- parseTicketsFile --------------------------------------------------------

describe('parseTicketsFile parity', () => {
  const cases: { name: string; raw: unknown }[] = [
    { name: 'bare array accepted', raw: TICKETS },
    { name: 'wrapped in { meta, tickets }', raw: { meta: { provider: 'anthropic', model: 'x' }, tickets: TICKETS } },
    { name: 'meta without a source', raw: { meta: { generatedAt: 'now' }, tickets: TICKETS } },
    { name: 'meta with a non-string provider', raw: { meta: { provider: 7 }, tickets: TICKETS } },
    { name: 'duplicate ids dropped', raw: [TICKETS[0], { ...TICKETS[0], subject: 'dupe' }, TICKETS[1]] },
    { name: 'unknown status coerced to open', raw: [{ ...TICKETS[1], status: 'escalated' }] },
    { name: 'missing status coerced to open', raw: [{ id: 3, subject: 'S', messages: [] }] },
    { name: 'non-integer id dropped', raw: [{ ...TICKETS[0], id: 1.5 }, TICKETS[1]] },
    { name: 'missing id dropped', raw: [{ subject: 'no id' }, TICKETS[1]] },
    { name: 'soft fields coerced', raw: [{ id: 4, subject: 9, status: 'open', messages: [{ body: 5, isStaff: 'yes' }] }] },
    // `.catch([])` sits on the messages array, so one bad message empties the whole conversation.
    { name: 'a non-object message empties the conversation', raw: [{ id: 5, subject: 'S', status: 'open', messages: ['hi'] }] },
    {
      name: 'one bad message discards the good ones too',
      raw: [{ id: 5, subject: 'S', status: 'open', messages: [TICKETS[1].messages[0], 'hi'] }]
    },
    { name: 'messages not an array', raw: [{ id: 6, subject: 'S', status: 'open', messages: 'none' }] },
    { name: 'unknown ticket fields stripped', raw: [{ ...TICKETS[1], extra: true }] },
    { name: 'no usable tickets', raw: [{ subject: 'nope' }] },
    { name: 'empty array', raw: [] },
    { name: 'not a tickets file', raw: { meta: {} } }
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(portTickets.parseTicketsFile(c.raw)).toEqual(parseTicketsFile(c.raw))
    })
  }

  it('the shared expectations hold in both', () => {
    expect(portTickets.parseTicketsFile([{ ...TICKETS[1], status: 'escalated' }])?.tickets[0].status).toBe('open')
    expect(portTickets.parseTicketsFile([TICKETS[0], TICKETS[0]])?.tickets).toHaveLength(1)
    expect(portTickets.parseTicketsFile([{ subject: 'nope' }])).toBeNull()
  })
})

// --- normalizeEvalFile -------------------------------------------------------

describe('normalizeEvalFile parity', () => {
  /** Exactly what the engine will write: create → apply LLM results → atomic JSON write. */
  function engineFile() {
    const fresh = portEvalFile.createWorkingFile({
      appVersion: '0.1.0',
      now: '2026-08-12T10:00:00.000Z',
      dataset: {
        fingerprint: portFingerprint.datasetFingerprint(TICKETS),
        ticketCount: TICKETS.length,
        source: { provider: 'claude-skill', model: 'Claude Code subagents' }
      },
      config: {
        fingerprint: portFingerprint.configFingerprint(SCHEMA, RULES),
        schema: portSchema.normalizeSchema(SCHEMA),
        rules: RULES
      }
    })
    const first = portValidate.validateValues({ empathy: 9, resolved: 'yes', categories: ['bug', 'nope'] }, SCHEMA)
    return portEvalFile.applyLlmResults(fresh, {
      provider: 'claude-code',
      model: 'Opus 5',
      results: [
        { ticketId: 1, values: first.values, evaluatedAt: '2026-08-12T10:01:00.000Z', error: null, issues: first.issues },
        { ticketId: 2, values: {}, evaluatedAt: '2026-08-12T10:01:00.000Z', error: 'no result for this ticket' }
      ]
    })
  }

  it('a file written by the engine round-trips through the app normalizer unchanged', () => {
    const onDisk = roundTrip(engineFile())
    const app = normalizeEvalFile(onDisk)
    expect(app).not.toBeNull()
    expect(app).toEqual(portEvalFile.normalizeEvalFile(onDisk))
    // Nothing the engine wrote is stripped: both results survive, with their repair trail.
    expect(app!.evaluators[0]).toMatchObject({ id: 'llm', kind: 'llm', name: 'LLM · Opus 5', provider: 'claude-code' })
    expect(app!.evaluators[0].results).toHaveLength(2)
    expect(app!.evaluators[0].results[0].issues).toEqual(onDisk.evaluators[0].results[0].issues)
    expect(app!.meta.config.fingerprint).toBe(portFingerprint.configFingerprint(SCHEMA, RULES))
  })

  it('agrees with the app over a case table of hand-edited files', () => {
    const base = roundTrip(engineFile())
    const withHuman = roundTrip(base)
    withHuman.evaluators.push({
      id: 'human',
      kind: 'human',
      name: 'Brian',
      results: [{ ticketId: 1, values: { empathy: 3, note: 'terse' }, evaluatedAt: '2026-08-12T11:00:00.000Z' }]
    })

    const cases: { name: string; raw: unknown }[] = [
      { name: 'engine file', raw: base },
      { name: 'with a human evaluator', raw: withHuman },
      { name: 'not an object', raw: 'nope' },
      { name: 'not a qval file', raw: { meta: { app: 'qbort' }, tickets: [] } },
      { name: 'missing dataset fingerprint', raw: { ...base, meta: { ...base.meta, dataset: { ticketCount: 2 } } } },
      { name: 'missing config fingerprint', raw: { ...base, meta: { ...base.meta, config: { schema: [], rules: '' } } } },
      { name: 'soft meta fields defaulted', raw: { ...base, meta: { ...base.meta, appVersion: 7, updatedAt: null } } },
      { name: 'unparseable config schema falls back', raw: { ...base, meta: { ...base.meta, config: { ...base.meta.config, schema: 'x', rules: 5 } } } },
      { name: 'evaluators missing', raw: { meta: base.meta } },
      { name: 'evaluators not an array', raw: { ...base, evaluators: 'nope' } },
      { name: 'one bad evaluator empties the list', raw: { ...base, evaluators: [base.evaluators[0], { id: '', kind: 'llm', results: [] }] } },
      { name: 'unknown evaluator kind', raw: { ...base, evaluators: [{ id: 'x', kind: 'robot', results: [] }] } },
      { name: 'duplicate ticketIds deduped', raw: dupeResults(base) },
      { name: 'a bad result empties that evaluator', raw: badResult(base) },
      { name: 'mixed-type value array empties the values map', raw: mixedValues(base) }
    ]

    for (const c of cases) {
      expect(portEvalFile.normalizeEvalFile(c.raw), c.name).toEqual(normalizeEvalFile(c.raw))
    }

    expect(normalizeEvalFile(dupeResults(base))!.evaluators[0].results).toHaveLength(2)
    expect(normalizeEvalFile(badResult(base))!.evaluators[0].results).toHaveLength(0)
    expect(normalizeEvalFile(mixedValues(base))!.evaluators[0].results[0].values).toEqual({})
  })

  function dupeResults(base: any) {
    const f = roundTrip(base)
    f.evaluators[0].results.push({ ...f.evaluators[0].results[0], evaluatedAt: 'later' })
    return f
  }

  function badResult(base: any) {
    const f = roundTrip(base)
    f.evaluators[0].results[1] = { ticketId: 'two', values: {}, evaluatedAt: '' }
    return f
  }

  function mixedValues(base: any) {
    const f = roundTrip(base)
    // `.catch({})` sits on the record, so one bad value discards the ticket's other values.
    f.evaluators[0].results[0].values = { resolved: true, categories: ['bug', 3] }
    return f
  }
})

// --- Behavioral helpers shared by the engine ---------------------------------

describe('evalFile helper parity', () => {
  const scored: EvalResult = { ticketId: 1, values: { resolved: true }, evaluatedAt: 'now' }
  const errored: EvalResult = { ticketId: 2, values: {}, evaluatedAt: 'now', error: 'boom' }
  const dropped: EvalResult = {
    ticketId: 3,
    values: { resolved: true },
    evaluatedAt: 'now',
    issues: [{ key: 'empathy', action: 'dropped', original: 'x' }]
  }

  it('needsAttention / isScoredResult match the app', () => {
    for (const r of [undefined, scored, errored, dropped]) {
      expect(portEvalFile.needsAttention(r)).toBe(needsAttention(r))
    }
    expect(portEvalFile.needsAttention(undefined)).toBe(true)
    expect(portEvalFile.needsAttention(scored)).toBe(false)
    for (const r of [scored, errored, dropped]) {
      expect(portEvalFile.isScoredResult(r)).toBe(isScoredResult(r))
    }
  })

  it('mergeResults matches the app (cleaner-wins across the retry round)', () => {
    // The first attempt's value survives a worse retry, and the resolved drop issue clears.
    const retry: EvalResult = { ticketId: 3, values: { empathy: 2, resolved: false }, evaluatedAt: 'later' }
    const cases: [EvalResult, EvalResult | undefined][] = [
      [dropped, retry],
      [scored, undefined],
      [errored, { ticketId: 2, values: { resolved: true }, evaluatedAt: 'later' }],
      [errored, { ticketId: 2, values: {}, evaluatedAt: 'later', error: 'boom again' }]
    ]
    for (const [a, b] of cases) {
      expect(portEvalFile.mergeResults(a, b)).toEqual(mergeResults(a, b, SCHEMA))
    }
    expect(portEvalFile.mergeResults(dropped, retry)).toEqual({
      ticketId: 3,
      values: { empathy: 2, resolved: true },
      evaluatedAt: 'now',
      error: null
    })
  })
})
