/**
 * End-to-end tests for the Claude Code skill's engine (`plugin/skills/evaluate-tickets/engine.mjs`).
 *
 * Each test drives the real CLI with `child_process` in its own temp directory, with hand-written
 * batch files standing in for the subagents. That is the whole point: the engine's contract with
 * `SKILL.md` is its **exit codes and its first stdout/stderr token**, and a subagent is only ever a
 * file that appears (or doesn't) at a path the engine printed. Nothing here touches the network or
 * spawns a real agent, so the suite is deterministic and offline like the rest of the repo's tests.
 *
 * The other half of the contract (that a file the engine writes is one the app can open and merge)
 * is checked by running `normalizeEvalFile` and both fingerprint functions over the produced
 * `.qval.json`. Those come from `plugin/lib/`, which is now the only copy of that logic, so this
 * checks the wiring rather than two implementations agreeing.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { applyHumanValues, normalizeEvalFile } from '@lib/evalFile.mjs'
import { configFingerprint, datasetFingerprint } from '@lib/fingerprint.mjs'
import { DEFAULT_SCHEMA, normalizeSchema } from '@lib/schema.mjs'
import { DEFAULT_RULES } from '@lib/rules.mjs'
import { SYSTEM_PROMPT } from '@lib/promptCompiler.mjs'
import { parseTicketsFile } from '@lib/tickets.mjs'
import type { EvalFile, EvalResult, Ticket } from '@shared/types'

// --- Fixtures ----------------------------------------------------------------

const ENGINE = resolve(__dirname, '../plugin/skills/evaluate-tickets/engine.mjs')
const OUT_DIR = '.qval-run'
/** Generated artifacts go under `qval-output/` now, not loose in the working directory. */
const EVAL_FILE = join('qval-output', 'tickets.qval.json')
const MODEL = 'Opus 5'
/** Matched on the tail, since the engine prints a realpath and a macOS temp dir is a symlink. */
const ADOPTED_LINE = /^CONFIG_ADOPTED .*qval-output[/\\]tickets\.qval\.json$/m

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
        from: { name: 'Mike Rodriguez', email: 'mike@company.biz' },
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
  },
  {
    id: 3,
    subject: 'How do I export a report?',
    status: 'open',
    messages: [
      {
        from: { name: 'Jo Park', email: 'jo@example.com' },
        body: 'I need last quarter as a CSV.',
        isStaff: false,
        createdAt: '2026-06-30T08:05:00.000Z'
      }
    ]
  },
  {
    id: 4,
    subject: 'Webhook retries are duplicating orders',
    status: 'pending',
    messages: [
      {
        from: { name: 'Dana Reyes', email: 'dana@example.com' },
        body: 'Every retry creates another order row.',
        isStaff: false,
        createdAt: '2026-07-01T13:20:00.000Z'
      }
    ]
  }
]

const SCHEMA = [
  { key: 'empathy', label: 'Empathy', type: 'score', min: 1, max: 5, step: 1, description: 'Warmth of the staff reply.' },
  { key: 'resolved', label: 'Resolved', type: 'boolean' },
  { key: 'severity', label: 'Severity', type: 'enum', options: ['low', 'high'] },
  { key: 'note', label: 'Note', type: 'text' }
]

const RULES = 'Score the staff handling, not the customer.\n\nBe consistent across tickets.\n'

/** A well-formed answer for one ticket: every property valid, nothing to coerce or drop. */
const GOOD = { empathy: 4, resolved: true, severity: 'high', note: 'handled well' }

// --- Harness -----------------------------------------------------------------

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/**
 * `$ANTHROPIC_MODEL` is stripped from the inherited environment so a developer who has one
 * configured doesn't quietly turn the `MISSING_MODEL` tests green.
 */
const BASE_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env }
  delete env.ANTHROPIC_MODEL
  // Likewise a real Typesafe key, which would turn `MISSING_KEY` green. The network is stubbed for
  // every Jev run regardless (see `jevRun`), so a real key could never be sent anywhere.
  delete env.TYPESAFE_API_KEY
  return env
})()

/** A temp working directory holding a tickets file and a valid config, as `plan` expects. */
function makeDir(options: { config?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'qval-skill-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ meta: { provider: 'anthropic', model: 'x' }, tickets: TICKETS }, null, 2))
  if (options.config !== false) {
    writeFileSync(join(dir, 'EVAL_RULES.md'), RULES)
    writeFileSync(join(dir, 'EVAL_SCHEMA.json'), JSON.stringify(SCHEMA, null, 2))
  }
  return dir
}

interface Run {
  code: number
  out: string
  err: string
  /** First whitespace-delimited token of stdout: the skill's success signal. */
  outToken: string
  /** First token of stderr: the skill's refusal signal. */
  errToken: string
}

function engine(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const res = spawnSync(process.execPath, [ENGINE, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...BASE_ENV, ...env }
  })
  if (res.error) throw res.error
  const token = (s: string) => (s.trim().split(/\s+/)[0] ?? '')
  return { code: res.status ?? -1, out: res.stdout, err: res.stderr, outToken: token(res.stdout), errToken: token(res.stderr) }
}

const plan = (dir: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) =>
  engine(dir, ['plan', '--tickets', 'tickets.json', '--model', MODEL, ...extra], env)

const assemble = (dir: string, round = 0) => engine(dir, ['assemble', '--round', String(round)])

interface Batch {
  index: number
  ticketIds: number[]
  promptFile: string
  batchFile: string
}

/** What a round actually targets, asserted instead of the wording of the printed ROUND block. */
const batchesOf = (dir: string, round: number): Batch[] =>
  JSON.parse(readFileSync(join(dir, OUT_DIR, `round-${round}.json`), 'utf8')).batches

/**
 * Stand in for the subagents: for each batch of a planned round, write whatever the callback
 * returns to that batch's output file. Returning `null` writes nothing, which is how a subagent
 * that died or never ran looks to `assemble`.
 */
function respond(dir: string, round: number, reply: (ticketIds: number[], index: number) => string | null): Batch[] {
  const batches = batchesOf(dir, round)
  for (const b of batches) {
    const text = reply(b.ticketIds, b.index)
    if (text !== null) writeFileSync(b.batchFile, text)
  }
  return batches
}

/** The JSON object a well-behaved subagent writes: schema-keyed values under each ticket id. */
const answer = (ids: number[], values: (id: number) => unknown = () => GOOD) =>
  JSON.stringify(Object.fromEntries(ids.map((id) => [String(id), values(id)])), null, 2)

const readRaw = (dir: string, name = EVAL_FILE) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const writeRaw = (dir: string, value: unknown, name = EVAL_FILE) =>
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2))
const readContext = (dir: string) => JSON.parse(readFileSync(join(dir, OUT_DIR, 'run-context.json'), 'utf8'))

/** The eval file as the *app* reads it: the round trip every test's assertions run through. */
function readEval(dir: string, name = EVAL_FILE): EvalFile {
  const file = normalizeEvalFile(readRaw(dir, name))
  expect(file, 'the engine wrote a file the app cannot read').not.toBeNull()
  return file!
}

const llmOf = (file: EvalFile) => file.evaluators.find((e) => e.kind === 'llm')!
const resultFor = (file: EvalFile, ticketId: number): EvalResult | undefined =>
  llmOf(file).results.find((r) => r.ticketId === ticketId)

/** Every file under `dir`, path + contents, so "this command wrote nothing" is checkable. */
function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(`${relative(dir, p)}\n${readFileSync(p, 'utf8')}`)
    }
  }
  walk(dir)
  return out
}

// --- init + config -----------------------------------------------------------
// Mostly exit codes: these two commands are control flow for `SKILL.md`. The exception is what
// `init` writes, which has to be the same starter config the review settings default to.

describe('init + config', () => {
  it('writes the starter config files and exits 3 to say it created them', () => {
    const dir = makeDir({ config: false })

    const first = engine(dir, ['init'])
    expect(first.code).toBe(3)
    expect(first.outToken).toBe('CREATED')
    expect(first.out).toContain('EVAL_RULES.md')
    expect(first.out).toContain('EVAL_SCHEMA.json')

    // Second run touches nothing and exits 0: the skill may proceed.
    const second = engine(dir, ['init'])
    expect(second.code).toBe(0)
    expect(second.outToken).toBe('EXISTS')
    expect(second.out).toContain('READY')
  })

  it('writes the same starter config the review settings default to', () => {
    // `init` and the review settings are two consumers of one definition (the starter config), and
    // both hash their answer into the config fingerprint. If they ever disagree, two users who each
    // accepted the defaults get files that refuse to merge, and the refusal says their criteria
    // differ, which is true and unhelpful. The fingerprint is the
    // assertion that matters. The two above it are there to say which half moved.
    const dir = makeDir({ config: false })
    expect(engine(dir, ['init']).code).toBe(3)

    const rules = readFileSync(join(dir, 'EVAL_RULES.md'), 'utf8')
    const schema = JSON.parse(readFileSync(join(dir, 'EVAL_SCHEMA.json'), 'utf8'))
    expect(rules.trim()).toBe(DEFAULT_RULES.trim())
    expect(schema).toEqual({ scorer: 'claude', properties: DEFAULT_SCHEMA })
    expect(configFingerprint(normalizeSchema(schema.properties), rules)).toBe(
      configFingerprint(normalizeSchema(DEFAULT_SCHEMA), DEFAULT_RULES)
    )
  })

  it('reads a bare-array schema file as the claude scorer', () => {
    const dir = makeDir()
    const run = engine(dir, ['config'])
    expect(run.code).toBe(0)
    expect(run.out).toContain('SCORER claude')
    expect(run.out).toContain(`FINGERPRINT ${configFingerprint(normalizeSchema(SCHEMA), RULES)}`)
  })

  it('accepts the wrapped form and fingerprints a claude one exactly like the bare array', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'EVAL_SCHEMA.json'), JSON.stringify({ scorer: 'claude', properties: SCHEMA }, null, 2))
    const run = engine(dir, ['config'])
    expect(run.code).toBe(0)
    expect(run.out).toContain(`FINGERPRINT ${configFingerprint(normalizeSchema(SCHEMA), RULES)}`)
  })

  it('refuses an unknown scorer rather than reading it as claude', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'EVAL_SCHEMA.json'), JSON.stringify({ scorer: 'gpt', properties: SCHEMA }))
    const run = engine(dir, ['config'])
    expect(run.code).toBe(2)
    expect(run.err).toContain('BAD_SCORER')
  })

  it('reports what the jev scorer cannot ask, row by row', () => {
    const dir = makeDir()
    const properties = [
      { key: 'notes', label: 'Notes', type: 'text', instructions: 'Anything else?' },
      { key: 'tone', label: 'Tone', type: 'score', min: 1, max: 5, step: 1, instructions: 'How warm?' },
      { key: 'a', label: 'A', type: 'boolean', instructions: 'Was it solved?' },
      { key: 'b', label: 'B', type: 'boolean', instructions: 'Was it solved?' },
      { key: 'c', label: 'C', type: 'boolean' }
    ]
    writeFileSync(join(dir, 'EVAL_SCHEMA.json'), JSON.stringify({ scorer: 'jev', properties }))
    const run = engine(dir, ['config'])
    expect(run.code).toBe(2)
    expect(run.out).toContain('SCORER jev')
    expect(run.err).toContain('#1 notes: Jev cannot score text properties.')
    expect(run.err).toContain('#2 tone: A Jev score needs at least 2 levels.')
    expect(run.err).toMatch(/#3 a: Another property asks Jev the same question/)
    expect(run.err).toMatch(/#4 b: Another property asks Jev the same question/)
    expect(run.err).toContain('#5 c: Jev needs instructions')
  })

  it('passes a valid jev schema, stores a scale as 0..n-1, and keeps the jev fields on --write', () => {
    const dir = makeDir()
    const properties = [
      {
        key: 'tone', label: 'Tone', type: 'score', instructions: 'How warm was the reply?',
        levels: [{ label: 'Cold', description: 'Curt.' }, { label: 'Neutral' }, { label: 'Warm' }]
      },
      { key: 'solved', label: 'Solved', type: 'boolean', instructions: 'Was it solved?', trueDescription: 'Fixed.' }
    ]
    writeFileSync(join(dir, 'EVAL_SCHEMA.json'), JSON.stringify({ scorer: 'jev', properties }))
    const run = engine(dir, ['config', '--write'])
    expect(run.code).toBe(0)
    expect(run.out).toContain('levels Cold | Neutral | Warm')
    const written = JSON.parse(readFileSync(join(dir, 'EVAL_SCHEMA.json'), 'utf8'))
    expect(written.scorer).toBe('jev')
    expect(written.properties[0]).toMatchObject({ min: 0, max: 2, step: 1, instructions: 'How warm was the reply?' })
    expect(written.properties[0].levels).toHaveLength(3)
    expect(written.properties[1].trueDescription).toBe('Fixed.')
    expect(run.out).toContain(`FINGERPRINT ${configFingerprint(normalizeSchema(properties, 'jev'), RULES, 'jev')}`)
  })

  it('will not plan a jev config onto Claude subagents', () => {
    const dir = makeDir()
    const properties = [{ key: 'solved', label: 'Solved', type: 'boolean', instructions: 'Was it solved?' }]
    writeFileSync(join(dir, 'EVAL_SCHEMA.json'), JSON.stringify({ scorer: 'jev', properties }))
    const run = plan(dir)
    expect(run.code).toBe(2)
    expect(run.err).toContain('WRONG_SCORER')
    expect(existsSync(join(dir, OUT_DIR, 'run-context.json'))).toBe(false)
  })

  it('refuses a schema the model could not satisfy (exit 2, nothing planned)', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'EVAL_SCHEMA.json'), JSON.stringify([{ key: 'x', label: 'X', type: 'rating' }], null, 2))
    const run = engine(dir, ['config'])
    expect(run.code).toBe(2)
    expect(run.err).toContain('Type must be one of')
    expect(run.err).toContain('SCHEMA_INVALID')
  })
})

// --- draft-check + draft-apply -------------------------------------------------
// The drafter is the ambient model, so a test stands in for it by writing the draft file, the same
// way the tests below stand in for subagents by writing batch files.

const USER_RULES = 'Judge the staff, not the customer.\n\nAnswer these questions:\n1. Was it solved?\n2. How warm was the reply?\n'

const JEV_DRAFT = {
  scorer: 'jev',
  properties: [
    {
      key: 'solved', label: 'Solved', type: 'boolean', instructions: 'Was the customer issue solved?',
      description: 'Solved means the underlying problem was fixed.', trueDescription: 'Fixed.'
    },
    {
      key: 'tone', label: 'Tone', type: 'score', instructions: 'How warm was the staff reply?',
      description: 'Warmth of the reply.', levels: [{ label: 'Cold', description: 'Curt.' }, { label: 'Warm' }]
    }
  ],
  rules: 'Judge the staff, not the customer.\n',
  notes: { tone: 'A range from cold to warm.' },
  removed: ['the numbered question list']
}

const CLAUDE_DRAFT = {
  scorer: 'claude',
  properties: [{ key: 'solved', label: 'Solved', type: 'boolean', description: 'Was the problem fixed?' }],
  rules: 'Judge the staff, not the customer.'
}

function writeDraft(dir: string, draft: unknown, name = join(OUT_DIR, 'draft.json')) {
  mkdirSync(join(dir, OUT_DIR), { recursive: true })
  writeFileSync(join(dir, name), JSON.stringify(draft, null, 2))
}

describe('draft-check + draft-apply', () => {
  it('checks a jev draft and prints the table, notes, warnings, and what left the rules', () => {
    const dir = makeDir({ config: false })
    writeFileSync(join(dir, 'RULES.md'), USER_RULES)
    writeDraft(dir, JEV_DRAFT)
    const before = snapshot(dir)

    const run = engine(dir, ['draft-check', '--scorer', 'jev'])
    expect(run.code).toBe(0)
    expect(run.outToken).toBe('DRAFT_OK')
    expect(run.out).toContain('levels Cold | Warm')
    expect(run.out).toContain('tone: A range from cold to warm.')
    expect(run.out).toContain('WARNINGS 2')
    expect(run.out).toContain('solved: This property does not say what yes and no each mean.')
    expect(run.out).toContain("tone: The level 'Warm' has no definition.")
    expect(run.out).toContain('REMOVED_FROM_RULES 1')
    expect(run.out).toContain('the numbered question list')
    const schema = normalizeSchema(JEV_DRAFT.properties, 'jev')
    expect(run.out).toContain(`FINGERPRINT ${configFingerprint(schema, JEV_DRAFT.rules, 'jev')}`)
    // A check writes nothing.
    expect(snapshot(dir)).toEqual(before)
  })

  it('refuses a draft for a different scorer than the user chose, and one the scorer cannot satisfy', () => {
    const dir = makeDir({ config: false })
    writeDraft(dir, JEV_DRAFT)
    expect(engine(dir, ['draft-check', '--scorer', 'claude'])).toMatchObject({ code: 2, errToken: 'SCORER_MISMATCH' })
    expect(engine(dir, ['draft-check'])).toMatchObject({ code: 1, errToken: 'MISSING_SCORER' })
    expect(engine(dir, ['draft-check', '--scorer', 'gpt'])).toMatchObject({ code: 1, errToken: 'BAD_SCORER' })

    // Jev refuses free text, with the same per-row wording `config` uses.
    writeDraft(dir, {
      ...JEV_DRAFT,
      properties: [...JEV_DRAFT.properties, { key: 'notes', label: 'Notes', type: 'text', instructions: 'Anything else?' }]
    })
    const bad = engine(dir, ['draft-check', '--scorer', 'jev'])
    expect(bad.code).toBe(2)
    expect(bad.err).toContain('#3 notes: Jev cannot score text properties.')
    expect(bad.err).toContain('SCHEMA_INVALID')

    writeDraft(dir, { scorer: 'jev', properties: [] })
    const envelope = engine(dir, ['draft-check', '--scorer', 'jev'])
    expect(envelope).toMatchObject({ code: 2, errToken: 'DRAFT_INVALID' })
    expect(envelope.err).toContain('"rules" must be')

    rmSync(join(dir, OUT_DIR, 'draft.json'))
    expect(engine(dir, ['draft-check', '--scorer', 'jev'])).toMatchObject({ code: 2, errToken: 'MISSING_DRAFT' })
  })

  it('names Jev fields left on a claude draft', () => {
    const dir = makeDir({ config: false })
    writeDraft(dir, { ...CLAUDE_DRAFT, properties: [{ ...CLAUDE_DRAFT.properties[0], instructions: 'Solved?' }] }, 'mine.json')
    const run = engine(dir, ['draft-check', '--scorer', 'claude', '--draft', 'mine.json'])
    expect(run.code).toBe(0)
    expect(run.out).toContain('"instructions" is a Jev field and is ignored under the claude scorer.')
  })

  it('applies a draft as the config files config reads, and never touches RULES.md', () => {
    const dir = makeDir({ config: false })
    writeFileSync(join(dir, 'RULES.md'), USER_RULES)
    writeDraft(dir, JEV_DRAFT)

    const run = engine(dir, ['draft-apply'])
    expect(run.code).toBe(0)
    expect(run.outToken).toBe('APPLIED')
    expect(run.out).toContain('CREATED')
    expect(readFileSync(join(dir, 'RULES.md'), 'utf8')).toBe(USER_RULES)

    const written = JSON.parse(readFileSync(join(dir, 'EVAL_SCHEMA.json'), 'utf8'))
    expect(written).toEqual({ scorer: 'jev', properties: normalizeSchema(JEV_DRAFT.properties, 'jev') })
    expect(readFileSync(join(dir, 'EVAL_RULES.md'), 'utf8')).toBe(JEV_DRAFT.rules)

    // What was applied is exactly what was checked: the same config, the same fingerprint.
    const checked = engine(dir, ['config'])
    expect(checked.code).toBe(0)
    expect(checked.out).toContain(`FINGERPRINT ${configFingerprint(written.properties, JEV_DRAFT.rules, 'jev')}`)

    // A claude draft replaces it, and the rules gain the trailing newline every config file has.
    writeDraft(dir, CLAUDE_DRAFT)
    const again = engine(dir, ['draft-apply'])
    expect(again.out).toContain('REPLACED')
    expect(JSON.parse(readFileSync(join(dir, 'EVAL_SCHEMA.json'), 'utf8')).scorer).toBe('claude')
    expect(readFileSync(join(dir, 'EVAL_RULES.md'), 'utf8')).toBe(`${CLAUDE_DRAFT.rules}\n`)
  })

  it('re-validates on apply, so an edited draft that no longer passes writes nothing', () => {
    const dir = makeDir()
    writeDraft(dir, { ...JEV_DRAFT, properties: [{ key: 'x', label: 'X', type: 'text' }] })
    const before = snapshot(dir)
    const run = engine(dir, ['draft-apply'])
    expect(run.code).toBe(2)
    expect(run.err).toContain('SCHEMA_INVALID')
    expect(snapshot(dir)).toEqual(before)
  })

  it('names eval files scored under other criteria, and leaves them alone', () => {
    const dir = makeDir()
    plan(dir)
    respond(dir, 0, (ids) => answer(ids))
    expect(assemble(dir).code).toBe(0)
    const evalBefore = readFileSync(join(dir, EVAL_FILE), 'utf8')

    writeDraft(dir, CLAUDE_DRAFT)
    const checked = engine(dir, ['draft-check', '--scorer', 'claude'])
    expect(checked.out).toContain('OTHER_CRITERIA')
    expect(checked.out).toContain(join('qval-output', 'tickets.qval.json'))
    const applied = engine(dir, ['draft-apply'])
    expect(applied.code).toBe(0)
    expect(applied.out).toContain('OTHER_CRITERIA')
    expect(readFileSync(join(dir, EVAL_FILE), 'utf8')).toBe(evalBefore)

    // The existing guard still holds: the new criteria do not score into the old file.
    expect(plan(dir)).toMatchObject({ code: 2, errToken: 'CONFIG_MISMATCH' })
  })

  it('leaves an eval file with no scores off the list, since the next run adopts the new config', () => {
    const dir = makeDir()
    // Subagents that never wrote leave a file whose results are all errors: unscored.
    plan(dir)
    assemble(dir)

    writeDraft(dir, CLAUDE_DRAFT)
    const checked = engine(dir, ['draft-check', '--scorer', 'claude'])
    expect(checked.code).toBe(0)
    expect(checked.out).not.toContain('OTHER_CRITERIA')
  })

  it('refuses to apply while any review session here is live, since it writes the config back', () => {
    const dir = makeDir()
    writeDraft(dir, CLAUDE_DRAFT)
    writeFileSync(
      join(dir, OUT_DIR, 'review-session.json'),
      JSON.stringify({ status: 'live', pid: process.pid, url: 'http://127.0.0.1:1/?t=x', workingPath: join(dir, 'other.qval.json') })
    )
    const before = snapshot(dir)
    expect(engine(dir, ['draft-apply'])).toMatchObject({ code: 2, errToken: 'SESSION_LIVE' })
    expect(snapshot(dir)).toEqual(before)
  })
})

// --- plan → assemble ---------------------------------------------------------

describe('plan → assemble', () => {
  it('produces a file the app can read, with the resolved model recorded on the evaluator', async () => {
    const dir = makeDir()

    const planned = plan(dir)
    expect(planned.code).toBe(0)
    expect(planned.outToken).toBe('PLANNED')
    // The resolved model is echoed because it is stamped permanently into the file, the one piece
    // of the printed prose the plan doc actually specifies. What the round targets is asserted off
    // the manifest instead, so the wording of the ROUND block stays free to change.
    expect(planned.out).toContain(`model=${MODEL} (--model)`)
    expect(batchesOf(dir, 0).flatMap((b) => b.ticketIds)).toEqual([1, 2, 3, 4])

    // The prompt file is the subagent's entire input: system prompt inlined (a subagent has no
    // system slot), rules, schema, and every targeted ticket.
    const prompt = readFileSync(join(dir, OUT_DIR, 'prompt-0-0.txt'), 'utf8')
    expect(prompt.startsWith(SYSTEM_PROMPT)).toBe(true)
    expect(prompt).toContain(RULES.trim())
    for (const t of TICKETS) expect(prompt).toContain(t.subject)

    respond(dir, 0, (ids) => answer(ids))
    const done = assemble(dir)
    expect(done.code).toBe(0)
    expect(done.outToken).toBe('ASSEMBLED')
    expect(done.out).toContain('EVALUATED 4')
    expect(done.out).toContain('DROPPED 0')
    expect(done.out).toContain('FAILED 0')
    expect(done.out).toContain('NEEDS_RETRY 0')

    const file = readEval(dir)
    expect(llmOf(file)).toMatchObject({ id: 'llm', kind: 'llm', name: `LLM · ${MODEL}`, provider: 'claude-code', model: MODEL })
    expect(llmOf(file).results.map((r) => r.ticketId)).toEqual([1, 2, 3, 4])
    for (const r of llmOf(file).results) {
      expect(r.values).toEqual(GOOD)
      expect(r.error ?? null).toBeNull()
      expect(r.issues ?? []).toEqual([])
    }

    // Both fingerprints have to agree with the app's own, or the file silently stops merging.
    const tickets = parseTicketsFile(readRaw(dir, 'tickets.json'))!.tickets
    expect(file.meta.dataset.fingerprint).toBe(await datasetFingerprint(tickets))
    expect(file.meta.config.fingerprint).toBe(await configFingerprint(normalizeSchema(SCHEMA), RULES))
    expect(file.meta.dataset.ticketCount).toBe(4)
    expect(file.meta.config.schema).toEqual(normalizeSchema(SCHEMA))

    // Nothing the engine wrote gets stripped on the way through the app's normalizer.
    expect(file).toEqual(normalizeEvalFile(readRaw(dir)))
  })

  it('splits into batches and drops per value, never per ticket', () => {
    const dir = makeDir()
    plan(dir, ['--batch-size', '2'])
    expect(batchesOf(dir, 0).map((b) => b.ticketIds)).toEqual([[1, 2], [3, 4]])

    // `validateValues` itself is covered by the parity suite. What's under test here is that
    // `assemble` runs it against the file's own schema snapshot and turns drops into the counts
    // SKILL.md branches on: a dropped value keeps the ticket, and schedules a retry.
    respond(dir, 0, (ids, index) => answer(ids, () => (index === 0 ? GOOD : { ...GOOD, severity: 'critical' })))
    const done = assemble(dir)
    expect(done.out).toContain('EVALUATED 4')
    expect(done.out).toContain('DROPPED 2')
    expect(done.out).toContain('FAILED 0')
    expect(done.out).toContain('NEEDS_RETRY 2')

    const file = readEval(dir)
    expect(resultFor(file, 3)!.values).toEqual({ empathy: 4, resolved: true, note: 'handled well' })
    expect(resultFor(file, 3)!.issues).toEqual([{ key: 'severity', action: 'dropped', original: 'critical' }])
  })

  it('ignores ids the model invents and records an error for ones it skips', () => {
    const dir = makeDir()
    plan(dir)
    // The model answers for ticket 1 and for a ticket that does not exist. Ids come from the
    // manifest, so 99 is ignored and 2/3/4 are recorded as skipped rather than vanishing.
    respond(dir, 0, () => JSON.stringify({ '1': GOOD, '99': GOOD }))
    const done = assemble(dir)
    expect(done.out).toContain('EVALUATED 1')
    expect(done.out).toContain('FAILED 3')

    const file = readEval(dir)
    expect(llmOf(file).results.map((r) => r.ticketId)).toEqual([1, 2, 3, 4])
    expect(resultFor(file, 2)!.error).toBe('Model did not return a result for this ticket.')
  })
})

// --- failures and the retry round --------------------------------------------

describe('failed batches and the single retry round', () => {
  it('records an error per ticket for garbled and missing output, then resolves them on retry', () => {
    const dir = makeDir()
    plan(dir, ['--batch-size', '1'])

    respond(dir, 0, (ids, index) => {
      if (index === 0) return 'Sure! Here are my thoughts on these tickets: they were handled well.'
      if (index === 1) return null // the subagent never wrote its file
      if (index === 2) return answer(ids)
      return '{}' // a valid object that simply omits the ticket
    })

    const first = assemble(dir)
    expect(first.code).toBe(0)
    expect(first.out).toContain('EVALUATED 1')
    expect(first.out).toContain('FAILED 3')
    expect(first.out).toContain('NEEDS_RETRY 3')

    const afterRound0 = readEval(dir)
    expect(resultFor(afterRound0, 1)!.error).toBe('Batch output was not a JSON object of ticket results.')
    expect(resultFor(afterRound0, 2)!.error).toBe('No output was produced for this batch.')
    expect(resultFor(afterRound0, 3)!.values).toEqual(GOOD)
    expect(resultFor(afterRound0, 4)!.error).toBe('Model did not return a result for this ticket.')

    const retry = engine(dir, ['retry', '--round', '1'])
    expect(retry.code).toBe(0)
    expect(retry.outToken).toBe('RETRY')
    // The retry round targets exactly the three that failed, and nothing that already scored.
    expect(batchesOf(dir, 1).flatMap((b) => b.ticketIds).sort()).toEqual([1, 2, 4])

    respond(dir, 1, (ids) => answer(ids))
    const second = assemble(dir, 1)
    expect(second.out).toContain('EVALUATED 3')
    expect(second.out).toContain('FAILED 0')
    // Retry is capped at one round, so a retry round never schedules more work.
    expect(second.out).toContain('NEEDS_RETRY 0')
    expect(second.out).not.toContain('RESIDUAL')

    const file = readEval(dir)
    expect(llmOf(file).results.filter((r) => r.error)).toEqual([])
    for (const r of llmOf(file).results) expect(r.values).toEqual(GOOD)
  })

  it('reports what a retry could not fix as RESIDUAL rather than as work to schedule', () => {
    const dir = makeDir()
    plan(dir, ['--batch-size', '4'])
    respond(dir, 0, () => null)
    assemble(dir)

    engine(dir, ['retry', '--round', '1'])
    respond(dir, 1, () => 'still not JSON')
    const second = assemble(dir, 1)
    expect(second.out).toContain('FAILED 4')
    expect(second.out).toContain('NEEDS_RETRY 0')
    expect(second.out).toContain('RESIDUAL 4')
  })

  it('merges cleaner-wins: a value that validated in round 0 survives a round-1 batch that drops it', () => {
    const dir = makeDir()
    plan(dir, ['--mode', 'selection', '--ids', '1', '--batch-size', '1'])

    // Round 0: empathy validates, severity is dropped, so the ticket is retried.
    respond(dir, 0, (ids) => answer(ids, () => ({ empathy: 4, severity: 'nope' })))
    expect(assemble(dir).out).toContain('NEEDS_RETRY 1')
    expect(resultFor(readEval(dir), 1)!.values).toEqual({ empathy: 4 })

    // Round 1 fixes severity but this time mangles empathy. The good first-pass value must win.
    engine(dir, ['retry', '--round', '1'])
    respond(dir, 1, (ids) => answer(ids, () => ({ empathy: 'very good', resolved: true, severity: 'high' })))
    const second = assemble(dir, 1)
    expect(second.out).toContain('DROPPED 0')
    expect(second.out).not.toContain('RESIDUAL')

    const result = resultFor(readEval(dir), 1)!
    expect(result.values).toEqual({ empathy: 4, resolved: true, severity: 'high' })
    expect(result.error ?? null).toBeNull()
    // Both drops were resolved across the two attempts, so no repair trail is left behind.
    expect(result.issues ?? []).toEqual([])
  })

  it('caps retry at one round and refuses to retry a round that was never assembled', () => {
    const dir = makeDir()
    plan(dir)

    const early = engine(dir, ['retry', '--round', '1'])
    expect(early.code).toBe(2)
    expect(early.errToken).toBe('NOT_ASSEMBLED')

    respond(dir, 0, (ids) => answer(ids))
    assemble(dir)

    const capped = engine(dir, ['retry', '--round', '2'])
    expect(capped.code).toBe(2)
    expect(capped.errToken).toBe('RETRY_CAPPED')

    const nothing = engine(dir, ['retry', '--round', '1'])
    expect(nothing.code).toBe(0)
    expect(nothing.outToken).toBe('NOTHING_TO_RETRY')
  })
})

// --- target selection --------------------------------------------------------

describe('--mode remaining', () => {
  it('targets only unevaluated, errored, or dropped tickets', () => {
    const dir = makeDir()
    plan(dir, ['--batch-size', '1'])
    respond(dir, 0, (ids, index) => {
      if (index === 0) return answer(ids) // 1: clean
      if (index === 1) return null // 2: batch-level error
      if (index === 2) return answer(ids, () => ({ ...GOOD, empathy: 'excellent' })) // 3: dropped value
      return answer(ids) // 4: clean
    })
    assemble(dir)

    const next = plan(dir, ['--mode', 'remaining'])
    expect(next.code).toBe(0)
    expect(next.outToken).toBe('PLANNED')
    expect(readContext(dir)).toMatchObject({ mode: 'remaining', targetIds: [2, 3] })

    respond(dir, 0, (ids) => answer(ids))
    assemble(dir)

    const file = readEval(dir)
    expect(llmOf(file).results.filter((r) => r.error)).toEqual([])
    for (const r of llmOf(file).results) expect(r.values).toEqual(GOOD)

    // Once everything is clean there is nothing left to plan.
    const again = plan(dir, ['--mode', 'remaining'])
    expect(again.code).toBe(0)
    expect(again.outToken).toBe('NOTHING_TO_DO')
  })
})

describe('re-runs and the human evaluator', () => {
  it('rewrites only the targeted LLM results and never touches human results', () => {
    const dir = makeDir()
    plan(dir)
    respond(dir, 0, (ids) => answer(ids))
    assemble(dir)

    // A human evaluation done in the app, alongside the LLM one.
    const withHuman = readRaw(dir)
    const human = {
      id: 'human',
      kind: 'human',
      name: 'Brian',
      results: [
        { ticketId: 1, values: { empathy: 2, note: 'terse' }, evaluatedAt: '2026-08-12T11:00:00.000Z' },
        { ticketId: 2, values: { resolved: false }, evaluatedAt: '2026-08-12T11:05:00.000Z' }
      ]
    }
    withHuman.evaluators.push(human)
    writeRaw(dir, withHuman)

    plan(dir, ['--mode', 'selection', '--ids', '3'])
    respond(dir, 0, (ids) => answer(ids, () => ({ ...GOOD, empathy: 1, note: 'rescored' })))
    expect(assemble(dir).out).toContain('EVALUATED 1')

    const file = readEval(dir)
    expect(file.evaluators.find((e) => e.kind === 'human')).toEqual(human)
    expect(resultFor(file, 3)!.values).toEqual({ ...GOOD, empathy: 1, note: 'rescored' })
    // Every other LLM result is left exactly as the first run wrote it.
    for (const id of [1, 2, 4]) expect(resultFor(file, id)!.values).toEqual(GOOD)
  })

  it("never reads a previous run's batch output as this run's answer", () => {
    // Batch files are named by round and index, so a shorter run reuses a longer one's names. If
    // `plan` left them there, a subagent that wrote nothing would be indistinguishable from one
    // that returned the previous run's values, silently, re-stamped, and counted as EVALUATED.
    const dir = makeDir()
    plan(dir, ['--batch-size', '1']) // four tickets, four batches: batch-0-0 .. batch-0-3
    respond(dir, 0, (ids) => answer(ids))
    assemble(dir)

    // The review half keeps its state in the same directory, and it has to survive a re-plan.
    const sessionFile = join(dir, OUT_DIR, 'review-session.json')
    writeFileSync(sessionFile, JSON.stringify({ app: 'qval-review', status: 'done', pid: 1 }))
    writeFileSync(join(dir, OUT_DIR, 'settings.json'), JSON.stringify({ evaluatorName: 'Brian' }))

    plan(dir, ['--batch-size', '1', '--mode', 'selection', '--ids', '1']) // one batch: batch-0-0
    const left = readdirSync(join(dir, OUT_DIR)).sort()
    expect(left.filter((n) => n.startsWith('batch-'))).toEqual([])
    expect(left).toContain('review-session.json')
    expect(left).toContain('settings.json')

    // Nothing stands in for the subagent this time.
    const run = assemble(dir)
    expect(run.out).toContain('EVALUATED 0')
    expect(run.out).toContain('FAILED 1')

    const result = resultFor(readEval(dir), 1)!
    expect(result.values).toEqual({})
    expect(result.error).toBeTruthy()
    // The tickets this run did not target keep the first run's values, as ever.
    for (const id of [2, 3, 4]) expect(resultFor(readEval(dir), id)!.values).toEqual(GOOD)
  })
})

// --- refusals ----------------------------------------------------------------

describe('refusals', () => {
  it('refuses a dataset mismatch and writes nothing', () => {
    const dir = makeDir()
    plan(dir)
    respond(dir, 0, (ids) => answer(ids))
    assemble(dir)

    const tickets = readRaw(dir, 'tickets.json')
    tickets.tickets[0].messages[0].body += ' (edited)'
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify(tickets, null, 2))

    const before = snapshot(dir)
    const run = plan(dir)
    expect(run.code).toBe(2)
    expect(run.errToken).toBe('DATASET_MISMATCH')
    expect(run.err).toContain('Different dataset')
    expect(snapshot(dir)).toEqual(before)
  })

  it('refuses a config mismatch and points at a new eval file', () => {
    const dir = makeDir()
    plan(dir)
    respond(dir, 0, (ids) => answer(ids))
    assemble(dir)

    writeFileSync(
      join(dir, 'EVAL_SCHEMA.json'),
      JSON.stringify([...SCHEMA, { key: 'followUp', label: 'Follow Up', type: 'boolean' }], null, 2)
    )

    const before = snapshot(dir)
    const run = plan(dir)
    expect(run.code).toBe(2)
    expect(run.errToken).toBe('CONFIG_MISMATCH')
    expect(run.err).toContain('Different rules or schema')
    expect(run.err).toContain('--eval-file')
    expect(snapshot(dir)).toEqual(before)
  })

  it('adopts the current config onto an eval file with no scores, and the round assembles under it', () => {
    const dir = makeDir()
    // A plan whose subagents never wrote anything leaves a file with error-only results: unscored.
    plan(dir)
    assemble(dir)
    expect(llmOf(readEval(dir)).results.every((r) => r.error)).toBe(true)

    const newSchema = [...SCHEMA, { key: 'followUp', label: 'Follow Up', type: 'boolean' }]
    writeFileSync(join(dir, 'EVAL_SCHEMA.json'), JSON.stringify(newSchema, null, 2))
    const newFp = configFingerprint(normalizeSchema(newSchema), RULES)

    const run = plan(dir)
    expect(run.code).toBe(0)
    expect(run.outToken).toBe('PLANNED')
    expect(run.out).toMatch(ADOPTED_LINE)
    expect(readEval(dir).meta.config.fingerprint).toBe(newFp)
    expect(readEval(dir).meta.config.schema.map((p) => p.key)).toContain('followUp')

    respond(dir, 0, (ids) => answer(ids, () => ({ ...GOOD, followUp: true })))
    const done = assemble(dir)
    expect(done.code).toBe(0)
    expect(done.out).toContain('EVALUATED 4')
    const file = readEval(dir)
    expect(file.meta.config.fingerprint).toBe(newFp)
    expect(resultFor(file, 1)?.values).toEqual({ ...GOOD, followUp: true })

    // Once scored, the lock holds again.
    writeFileSync(join(dir, 'EVAL_SCHEMA.json'), JSON.stringify(SCHEMA, null, 2))
    expect(plan(dir)).toMatchObject({ code: 2, errToken: 'CONFIG_MISMATCH' })
  })

  it('does not restamp an unscored file when a later guard refuses the plan', () => {
    const dir = makeDir()
    plan(dir)
    writeFileSync(join(dir, 'EVAL_RULES.md'), 'Different rules.\n')
    writeFileSync(
      join(dir, OUT_DIR, 'review-session.json'),
      JSON.stringify({ status: 'live', pid: process.pid, workingPath: join(dir, EVAL_FILE) })
    )
    const before = snapshot(dir)
    expect(plan(dir)).toMatchObject({ code: 2, errToken: 'SESSION_LIVE' })
    expect(snapshot(dir)).toEqual(before)
    // A bad batch size is checked after the config, and must not write the restamp either.
    rmSync(join(dir, OUT_DIR, 'review-session.json'))
    const without = snapshot(dir)
    expect(plan(dir, ['--batch-size', '0']).errToken).toBe('BAD_BATCH_SIZE')
    expect(snapshot(dir)).toEqual(without)
  })

  it('refuses when no model can be resolved, and leaves the directory untouched', () => {
    const dir = makeDir()
    const before = snapshot(dir)

    const run = engine(dir, ['plan', '--tickets', 'tickets.json'])
    expect(run.code).toBe(1)
    expect(run.errToken).toBe('MISSING_MODEL')
    expect(snapshot(dir)).toEqual(before)

    // A bare `--model` parses as `true`, which must be the same refusal and not a model named "true".
    const bare = engine(dir, ['plan', '--tickets', 'tickets.json', '--model'])
    expect(bare.code).toBe(1)
    expect(bare.errToken).toBe('MISSING_MODEL')
    expect(snapshot(dir)).toEqual(before)
  })

  it('falls back to $ANTHROPIC_MODEL and records that model on the evaluator', () => {
    const dir = makeDir()
    const run = engine(dir, ['plan', '--tickets', 'tickets.json'], { ANTHROPIC_MODEL: 'Sonnet 5' })
    expect(run.code).toBe(0)
    expect(run.out).toContain('model=Sonnet 5 ($ANTHROPIC_MODEL)')
    expect(readContext(dir)).toMatchObject({ model: 'Sonnet 5', modelFrom: '$ANTHROPIC_MODEL' })

    respond(dir, 0, (ids) => answer(ids))
    assemble(dir)
    expect(llmOf(readEval(dir))).toMatchObject({ name: 'LLM · Sonnet 5', model: 'Sonnet 5', provider: 'claude-code' })
  })

  it('pins one model (and one provider) per file once anything is scored', () => {
    const dir = makeDir()
    plan(dir)
    respond(dir, 0, (ids) => answer(ids))
    assemble(dir)

    const before = snapshot(dir)
    const run = engine(dir, ['plan', '--tickets', 'tickets.json', '--model', 'Sonnet 5'])
    expect(run.code).toBe(2)
    expect(run.errToken).toBe('MODEL_LOCKED')
    expect(run.err).toContain(MODEL)
    expect(snapshot(dir)).toEqual(before)

    // A new eval file is the documented way out, and it is allowed to use the other model.
    const fresh = engine(dir, ['plan', '--tickets', 'tickets.json', '--model', 'Sonnet 5', '--eval-file', 'second.qval.json'])
    expect(fresh.code).toBe(0)
    expect(fresh.out).toContain('second.qval.json')

    // The same lock, on the other signal: a file the app already scored through a real provider.
    const raw = readRaw(dir)
    raw.evaluators[0].provider = 'anthropic'
    writeRaw(dir, raw)
    const locked = plan(dir)
    expect(locked.code).toBe(2)
    expect(locked.errToken).toBe('PROVIDER_LOCKED')
    expect(locked.err).toContain('anthropic')
  })

  it('assembles onto an eval file a review session edited while the round was out', () => {
    const dir = makeDir()
    plan(dir)
    respond(dir, 0, (ids) => answer(ids))

    // A review session saving one hand-entered score mid-round: `updatedAt` moves, both
    // fingerprints hold. This is the ordinary case, and it must not cost the round.
    const edited = applyHumanValues(readEval(dir), {
      name: 'Bri',
      ticketId: 2,
      values: { empathy: 2 },
      now: '2030-01-01T00:00:00.000Z'
    })
    writeRaw(dir, { ...edited, meta: { ...edited.meta, updatedAt: '2030-01-01T00:00:00.000Z' } })

    const run = assemble(dir)
    expect(run.code).toBe(0)
    expect(run.outToken).toBe('ASSEMBLED')

    // Both halves survive: the round's scores landed and the hand-entered one was not overwritten.
    const file = readEval(dir)
    expect(resultFor(file, 1)?.values).toMatchObject(GOOD)
    const human = file.evaluators.find((e) => e.kind === 'human')!
    expect(human.results.find((r) => r.ticketId === 2)?.values).toEqual({ empathy: 2 })
  })

  it('refuses to assemble onto an eval file that has become a different evaluation', async () => {
    const dir = makeDir()
    plan(dir)
    respond(dir, 0, (ids) => answer(ids))

    // Criteria re-stamped since `plan`. These answers describe a schema the file no longer holds,
    // and `assemble` validates against the file's own schema, so adopting it would score the round
    // against criteria its prompts never described.
    const raw = readRaw(dir)
    raw.meta.config.rules = 'Score something else entirely.'
    raw.meta.config.fingerprint = await configFingerprint(normalizeSchema(SCHEMA), raw.meta.config.rules)
    writeRaw(dir, raw)

    const run = assemble(dir)
    expect(run.code).toBe(2)
    expect(run.errToken).toBe('FILE_REPLACED')
    expect(run.err).toContain('criteria')
    // Refusing means refusing to write: the file is exactly as the session left it.
    expect(readRaw(dir)).toEqual(raw)

    // The other half of the same guard: an evaluation of different tickets.
    raw.meta.config.fingerprint = readContext(dir).configFingerprint
    raw.meta.dataset.fingerprint = raw.meta.dataset.fingerprint.replace(/.$/, (c: string) => (c === 'a' ? 'b' : 'a'))
    writeRaw(dir, raw)
    const other = assemble(dir)
    expect(other).toMatchObject({ code: 2, errToken: 'FILE_REPLACED' })
    expect(other.err).toContain('different tickets')
  })

  it('refuses to plan or assemble while a review session holds the same eval file', () => {
    const dir = makeDir()
    const record = (over: Record<string, unknown> = {}) => {
      mkdirSync(join(dir, OUT_DIR), { recursive: true })
      writeFileSync(
        join(dir, OUT_DIR, 'review-session.json'),
        JSON.stringify({
          app: 'qval-review',
          status: 'live',
          // Our own pid: alive by definition, without spawning anything to hold one open.
          pid: process.pid,
          url: 'http://127.0.0.1:1234/?t=x',
          workingPath: join(dir, EVAL_FILE),
          ...over
        })
      )
    }

    record()
    const refused = plan(dir)
    expect(refused.code).toBe(2)
    expect(refused.errToken).toBe('SESSION_LIVE')
    expect(refused.err).toContain('FINISH')
    // Refusing means writing nothing at all: no eval file, no run context.
    expect(readdirSync(dir).includes('qval-output')).toBe(false)

    // A session that ended, one whose process is gone, and one on a different file are all fine.
    record({ status: 'done' })
    expect(plan(dir).outToken).toBe('PLANNED')
    record({ pid: 2 ** 30 })
    expect(plan(dir).outToken).toBe('PLANNED')
    record({ workingPath: join(dir, 'other.qval.json') })
    expect(plan(dir).outToken).toBe('PLANNED')

    // And the guard covers `assemble` too, since that is the command that writes.
    respond(dir, 0, (ids) => answer(ids))
    record()
    expect(assemble(dir)).toMatchObject({ code: 2, errToken: 'SESSION_LIVE' })
  })

  it('rejects malformed flags with exit 1 and unusable state with exit 2', () => {
    const dir = makeDir()

    expect(plan(dir, ['--mode', 'wobble'])).toMatchObject({ code: 1, errToken: 'BAD_MODE' })
    expect(plan(dir, ['--mode', 'selection'])).toMatchObject({ code: 1, errToken: 'MISSING_IDS' })
    expect(plan(dir, ['--batch-size', '0'])).toMatchObject({ code: 1, errToken: 'BAD_BATCH_SIZE' })
    expect(engine(dir, ['plan', '--model', MODEL])).toMatchObject({ code: 1, errToken: 'MISSING_TICKETS' })
    expect(engine(dir, ['wat'])).toMatchObject({ code: 1 })

    // Unusable state, not a typo: ids the dataset doesn't have, and assembling with no run.
    expect(plan(dir, ['--mode', 'selection', '--ids', '9'])).toMatchObject({ code: 2, errToken: 'UNKNOWN_IDS' })
    expect(assemble(dir)).toMatchObject({ code: 2, errToken: 'NO_CONTEXT' })

    writeFileSync(join(dir, 'tickets.json'), '{ not json')
    expect(plan(dir)).toMatchObject({ code: 2, errToken: 'BAD_JSON' })
  })

  it('refuses a missing config instead of planning a doomed run', () => {
    const dir = makeDir({ config: false })
    const run = plan(dir)
    expect(run.code).toBe(2)
    expect(run.errToken).toBe('MISSING_RULES')
    expect(run.err).toContain('init')
  })
})

// --- status ------------------------------------------------------------------

// --- jev ---------------------------------------------------------------------
// The engine runs as a child process, so the network is replaced in that process: `--import`
// preloads a stub that swaps `globalThis.fetch` before the engine loads. The engine has no test
// hook, so production code is exactly what runs here, and nothing can reach a real host.

const STUB = pathToFileURL(resolve(__dirname, 'fixtures/typesafeFetchStub.mjs')).href
const KEY = 'ts-test-key-7f3a9c'

const JEV_PROPERTIES = [
  { key: 'resolved', label: 'Resolved', type: 'boolean', instructions: 'Was the issue resolved?' },
  { key: 'severity', label: 'Severity', type: 'enum', options: ['low', 'high'], instructions: 'How severe is it?' },
  { key: 'topics', label: 'Topics', type: 'enum', multiple: true, options: ['billing', 'bug'], instructions: 'Which topics apply?' },
  { key: 'tone', label: 'Tone', type: 'score', instructions: 'How warm was the reply?', levels: [{ label: 'Cold' }, { label: 'Ok' }, { label: 'Warm' }] }
]

type Reply = 'answer' | { status: number; body?: unknown; echoAuth?: boolean }

interface JevRun extends Run {
  /** The tickets the stub was asked about, in the order the requests arrived. */
  sent: string[]
  requests: Array<{ url: string; auth: string; ticketId: string; request: Record<string, any> }>
}

function makeJevDir(): string {
  const dir = makeDir()
  writeFileSync(join(dir, 'EVAL_SCHEMA.json'), JSON.stringify({ scorer: 'jev', properties: JEV_PROPERTIES }, null, 2))
  return dir
}

/** Run `jev` against the stub. The stub's plan and log live beside the directory, not in it, so
 *  `snapshot(dir)` sees only what the engine wrote. */
function jevRun(
  dir: string,
  extra: string[] = [],
  opts: { key?: string | null; replies?: { default?: Reply; tickets?: Record<string, Reply> } } = {}
): JevRun {
  const planPath = `${dir}-stub-plan.json`
  const logPath = `${dir}-stub-log.jsonl`
  writeFileSync(planPath, JSON.stringify(opts.replies ?? {}))
  rmSync(logPath, { force: true })
  dirs.push(planPath, logPath)
  const key = opts.key === undefined ? KEY : opts.key
  const res = spawnSync(process.execPath, ['--import', STUB, ENGINE, 'jev', '--tickets', 'tickets.json', ...extra], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...BASE_ENV, QVAL_STUB_PLAN: planPath, QVAL_STUB_LOG: logPath, ...(key === null ? {} : { TYPESAFE_API_KEY: key }) }
  })
  if (res.error) throw res.error
  const token = (s: string) => (s.trim().split(/\s+/)[0] ?? '')
  const requests = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  return {
    code: res.status ?? -1,
    out: res.stdout,
    err: res.stderr,
    outToken: token(res.stdout),
    errToken: token(res.stderr),
    requests,
    sent: requests.map((r) => r.ticketId)
  }
}

/** Every file the engine left under `dir`, as one string, for "the key is nowhere" checks. */
const everything = (dir: string) => snapshot(dir).join('\n')

describe('jev', () => {
  it('scores a jev config through Typesafe and records the requested model, with the reported one per result', () => {
    const dir = makeJevDir()
    const run = jevRun(dir)
    expect(run.code).toBe(0)
    expect(run.outToken).toBe('JEV_DONE')
    expect(run.out).toMatch(/SENT 4\nCACHED 0\nEVALUATED 4\nDROPPED 0\nFAILED 0/)
    expect(run.out).toContain('REPORTED_MODEL jev-1.13')

    // One request per ticket, to the real endpoint, the key in the header and nowhere in the body.
    expect([...run.sent].sort()).toEqual(['1', '2', '3', '4'])
    for (const r of run.requests) {
      expect(r.url).toBe('https://api.typesafe.ai/v1/systemone')
      expect(r.auth).toBe(`Bearer ${KEY}`)
      expect(r.request.model).toBe('jev-latest')
      expect(r.request.state.support_guidelines).toBe(RULES.trim())
      expect(JSON.stringify(r.request)).not.toContain(KEY)
    }

    const file = readEval(dir)
    expect(llmOf(file)).toMatchObject({ provider: 'typesafe', model: 'jev-latest', name: 'LLM · jev-latest' })
    expect(file.meta.config.scorer).toBe('jev')
    expect(file.meta.config.fingerprint).toBe(configFingerprint(normalizeSchema(JEV_PROPERTIES, 'jev'), RULES, 'jev'))
    // The stub says noul 0.8, the first option, and a score of 1.4, which snaps to level 1.
    expect(resultFor(file, 1)).toMatchObject({
      values: { resolved: true, severity: 'low', topics: ['billing', 'bug'], tone: 1 },
      reportedModel: 'jev-1.13',
      issues: [{ key: 'tone', action: 'clamped', original: 1.4 }]
    })

    // Each raw response is kept, by ticket id, for `--resume`.
    expect(readdirSync(join(dir, OUT_DIR, 'jev')).sort()).toEqual(['1.json', '2.json', '3.json', '4.json'])
    expect(run.out + run.err + everything(dir)).not.toContain(KEY)
  })

  it('refuses without a key, naming only the variable, before any request or write', () => {
    const dir = makeJevDir()
    const before = snapshot(dir)
    const run = jevRun(dir, [], { key: null })
    expect(run).toMatchObject({ code: 2, errToken: 'MISSING_KEY' })
    expect(run.err).toContain('TYPESAFE_API_KEY')
    expect(run.sent).toEqual([])
    expect(snapshot(dir)).toEqual(before)

    // Blank counts as missing: a key is trimmed before use.
    expect(jevRun(dir, [], { key: '   ' }).errToken).toBe('MISSING_KEY')
  })

  it('will not score a claude config, and plan will not score a jev one', () => {
    const claude = makeDir()
    const run = jevRun(claude)
    expect(run).toMatchObject({ code: 2, errToken: 'WRONG_SCORER' })
    expect(run.err).toContain('`plan`')
    expect(run.sent).toEqual([])
    expect(plan(makeJevDir())).toMatchObject({ code: 2, errToken: 'WRONG_SCORER' })
  })

  it('keeps the key out of everything when an error body echoes it back', () => {
    const dir = makeJevDir()
    const run = jevRun(dir, [], { replies: { tickets: { '2': { status: 422, body: 'bad criteria', echoAuth: true } } } })
    expect(run.code).toBe(0)
    expect(run.out).toMatch(/EVALUATED 3\n.*\nFAILED 1/s)
    expect(run.out).toContain('#2 Typesafe answered 422.')
    expect(run.out).toContain('[redacted]')
    expect(resultFor(readEval(dir), 2)?.error).toContain('bad criteria')
    // No response file for a failed request, so `--resume` sends it again.
    expect(existsSync(join(dir, OUT_DIR, 'jev', '2.json'))).toBe(false)
    expect(run.out + run.err + everything(dir)).not.toContain(KEY)
  })

  it('stops sending once the key is refused, and still writes what it has', () => {
    const dir = makeJevDir()
    const run = jevRun(dir, ['--concurrency', '1'], { replies: { default: { status: 401, body: 'nope', echoAuth: true } } })
    expect(run).toMatchObject({ code: 2, errToken: 'KEY_REJECTED' })
    expect(run.sent).toEqual(['1'])
    expect(run.out).toContain('UNSENT 3')
    expect(run.out + run.err + everything(dir)).not.toContain(KEY)
    expect(resultFor(readEval(dir), 1)?.error).toContain('TYPESAFE_API_KEY')
    expect(resultFor(readEval(dir), 2)).toBeUndefined()
  })

  it('resumes from the saved responses, re-sending only what has none, onto a file a human edited meanwhile', () => {
    const dir = makeJevDir()
    jevRun(dir, [], { replies: { tickets: { '3': { status: 422, body: 'try later' } } } })
    expect(resultFor(readEval(dir), 3)?.error).toContain('try later')

    // A review session saved a human score in between. The resumed run adopts that copy.
    const edited = applyHumanValues(readEval(dir), { name: 'Bri', ticketId: 2, values: { resolved: false }, now: '2030-01-01T00:00:00.000Z' })
    writeRaw(dir, { ...edited, meta: { ...edited.meta, updatedAt: '2030-01-01T00:00:00.000Z' } })

    const resumed = jevRun(dir, ['--resume'])
    expect(resumed.code).toBe(0)
    expect(resumed.out).toContain('resumed')
    expect(resumed.sent).toEqual(['3'])
    expect(resumed.out).toMatch(/SENT 1\nCACHED 3\nEVALUATED 4/)
    const file = readEval(dir)
    expect(resultFor(file, 3)).toMatchObject({ error: null, values: { resolved: true } })
    expect(file.evaluators.find((e) => e.kind === 'human')!.results).toEqual([
      { ticketId: 2, values: { resolved: false }, evaluatedAt: '2030-01-01T00:00:00.000Z' }
    ])
  })

  it('refuses to resume a run of a different eval file or different criteria', () => {
    const dir = makeJevDir()
    jevRun(dir)

    const other = jevRun(dir, ['--resume', '--eval-file', 'qval-output/other.qval.json'])
    expect(other).toMatchObject({ code: 2, errToken: 'RESUME_MISMATCH' })
    expect(other.sent).toEqual([])

    const ctx = readContext(dir)
    writeFileSync(join(dir, OUT_DIR, 'run-context.json'), JSON.stringify({ ...ctx, configFingerprint: 'sha256:else' }))
    const before = snapshot(dir)
    expect(jevRun(dir, ['--resume'])).toMatchObject({ code: 2, errToken: 'RESUME_MISMATCH' })
    expect(snapshot(dir)).toEqual(before)

    // A Claude run's context is never resumable as a Jev one.
    writeFileSync(join(dir, OUT_DIR, 'run-context.json'), JSON.stringify({ ...ctx, provider: 'claude-code' }))
    expect(jevRun(dir, ['--resume']).errToken).toBe('RESUME_MISMATCH')
  })

  it("deletes the last run's responses when a new run starts, and so does plan", () => {
    const dir = makeJevDir()
    jevRun(dir)
    writeFileSync(join(dir, OUT_DIR, 'jev', '99.json'), '{"answers":{}}')
    jevRun(dir, ['--mode', 'selection', '--ids', '2'])
    expect(readdirSync(join(dir, OUT_DIR, 'jev'))).toEqual(['2.json'])

    // The same scratch is per-run for a Claude run too, and the review's files are left alone.
    writeFileSync(join(dir, OUT_DIR, 'settings.json'), '{}')
    writeFileSync(join(dir, 'EVAL_SCHEMA.json'), JSON.stringify(SCHEMA))
    expect(plan(dir, ['--eval-file', 'claude.qval.json']).outToken).toBe('PLANNED')
    expect(existsSync(join(dir, OUT_DIR, 'jev'))).toBe(false)
    expect(existsSync(join(dir, OUT_DIR, 'settings.json'))).toBe(true)
  })

  it('holds the same guards as plan: a live review, the config, and the provider and model pin', () => {
    const dir = makeJevDir()
    mkdirSync(join(dir, OUT_DIR), { recursive: true })
    const session = join(dir, OUT_DIR, 'review-session.json')
    writeFileSync(session, JSON.stringify({ status: 'live', pid: process.pid, workingPath: join(dir, EVAL_FILE) }))
    expect(jevRun(dir)).toMatchObject({ code: 2, errToken: 'SESSION_LIVE', sent: [] })
    rmSync(session)

    jevRun(dir)
    const raw = readRaw(dir)
    raw.evaluators[0].model = 'jev-0.9'
    writeRaw(dir, raw)
    expect(jevRun(dir)).toMatchObject({ code: 2, errToken: 'MODEL_LOCKED', sent: [] })
    raw.evaluators[0].provider = 'claude-code'
    writeRaw(dir, raw)
    expect(jevRun(dir)).toMatchObject({ code: 2, errToken: 'PROVIDER_LOCKED', sent: [] })

    writeFileSync(join(dir, 'EVAL_RULES.md'), 'Different rules.\n')
    expect(jevRun(dir)).toMatchObject({ code: 2, errToken: 'CONFIG_MISMATCH', sent: [] })
  })

  it('adopts the current config onto an eval file with no scores, and scores under it', () => {
    const dir = makeJevDir()
    // Every request refused leaves a file whose only results are errors: unscored.
    jevRun(dir, [], { replies: { default: { status: 422, body: 'not yet' } } })
    expect(llmOf(readEval(dir)).results.every((r) => r.error)).toBe(true)

    writeFileSync(join(dir, 'EVAL_RULES.md'), 'Different rules.\n')
    const newFp = configFingerprint(normalizeSchema(JEV_PROPERTIES, 'jev'), 'Different rules.\n', 'jev')
    const run = jevRun(dir)
    expect(run.code).toBe(0)
    expect(run.outToken).toBe('JEV_DONE')
    expect(run.out).toMatch(ADOPTED_LINE)
    expect(run.out).toContain('EVALUATED 4')
    const file = readEval(dir)
    expect(file.meta.config.fingerprint).toBe(newFp)
    expect(file.meta.config.rules.trim()).toBe('Different rules.')
    expect(llmOf(file).results.every((r) => !r.error)).toBe(true)
  })
})

describe('status', () => {
  it('reports LLM and human completeness, errors, and dropped values', () => {
    const dir = makeDir()
    plan(dir, ['--batch-size', '1'])
    respond(dir, 0, (ids, index) => {
      if (index === 0) return null
      if (index === 1) return answer(ids, () => ({ ...GOOD, severity: 'critical' }))
      return answer(ids)
    })
    assemble(dir)

    // Only the counts are asserted; the line's layout is cosmetic and free to change.
    const run = engine(dir, ['status'])
    expect(run.code).toBe(0)
    expect(run.outToken).toBe('FILE')
    expect(run.out).toMatch(/LLM .*scored 3\/4 .*errors 1 .*dropped-values 1/)
    expect(run.out).toMatch(/HUMAN scored 0\/4/)
  })
})
