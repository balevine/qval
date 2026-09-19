/**
 * The two halves of Qval, checked against each other.
 *
 * `/qval:evaluate-tickets` (the engine) writes the LLM evaluator. `/qval:review` (the
 * server plus the browser's fetch client) writes the human one. The claim that has to hold is
 * that a file produced by one merges with a file produced by the other: same dataset, same schema,
 * same rules, so both fingerprints match and the comparison math has two streams to compare.
 *
 * That used to be `skillParity.test.ts`'s job, back when the logic existed twice. It exists once
 * now, so this checks the wiring instead of two implementations agreeing.
 *
 * It also could not be written until stage 6: driving the renderer's `apiClient` against a real
 * `node:http` server needs DOM and node types in one program, which the old tsconfig split forbade.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createReviewServer, DEFAULT_UI_FILE, TOKEN_HEADER } from '../plugin/server/server.mjs'
import { createApiClient } from '@/lib/apiClient'
import { aggregateSession } from '@lib/aggregate.mjs'
import { normalizeEvalFile } from '@lib/evalFile.mjs'
import { atomicWriteJson } from '@lib/fsUtil.mjs'
import { SettingsStore } from '@lib/settingsStore.mjs'
import { Workspace } from '@lib/workspace.mjs'
import type { EvalFile, EvalSchema, Ticket } from '@shared/types'

const ENGINE = resolve(__dirname, '../plugin/skills/evaluate-tickets/engine.mjs')

// --- Fixtures ----------------------------------------------------------------

const TICKETS: Ticket[] = [1, 2, 3].map((id) => ({
  id,
  subject: `Ticket ${id}`,
  status: 'open',
  messages: [
    {
      from: { name: 'Sarah Kim', email: 'sarah@example.com' },
      body: `Something went wrong (${id}).`,
      isStaff: false,
      createdAt: '2026-06-28T09:14:00.000Z'
    },
    {
      from: { name: 'Mike Rodriguez', email: 'mike@company.biz' },
      body: 'Sorted it out for you.',
      isStaff: true,
      createdAt: '2026-06-28T15:42:00.000Z'
    }
  ]
}))

const SCHEMA = [
  { key: 'empathy', label: 'Empathy', type: 'score', min: 1, max: 5, step: 1 },
  { key: 'resolved', label: 'Resolved', type: 'boolean' }
] as unknown as EvalSchema

const RULES = 'Score the staff handling, not the customer.\n'

/** What the LLM said, per ticket. Deliberately one point warmer than the human below. */
const LLM_VALUES = { empathy: 5, resolved: true }
/** What the person said. */
const HUMAN_VALUES = { empathy: 4, resolved: true }

let dir: string
let running: { close: () => Promise<void> }[] = []

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'qv-roundtrip-'))
  running = []
})
afterEach(async () => {
  await Promise.all(running.map((s) => s.close()))
  await fs.rm(dir, { recursive: true, force: true })
})

// --- The skill half ----------------------------------------------------------

/**
 * Run the engine end to end in `home` with hand-written batch files standing in for the subagents,
 * exactly as `skillEngine.test.ts` does, and return the eval file it wrote.
 */
function runSkill(home: string): string {
  writeFileSync(join(home, 'EVAL_RULES.md'), RULES)
  writeFileSync(join(home, 'EVAL_SCHEMA.json'), JSON.stringify(SCHEMA, null, 2))

  const engine = (args: string[]) => {
    const env = { ...process.env }
    delete env.ANTHROPIC_MODEL
    const res = spawnSync(process.execPath, [ENGINE, ...args], { cwd: home, encoding: 'utf8', env })
    if (res.error) throw res.error
    if (res.status !== 0) throw new Error(`engine ${args[0]} failed (${res.status}): ${res.stderr}`)
    return res
  }

  engine(['plan', '--tickets', 'tickets.json', '--model', 'Opus 5'])
  const round = JSON.parse(readFileSync(join(home, '.qval-run', 'round-0.json'), 'utf8'))
  for (const batch of round.batches as { ticketIds: number[]; batchFile: string }[]) {
    const answer = Object.fromEntries(batch.ticketIds.map((id) => [String(id), LLM_VALUES]))
    writeFileSync(batch.batchFile, JSON.stringify(answer, null, 2))
  }
  engine(['assemble', '--round', '0'])

  return join(home, 'tickets.qval.json')
}

// --- The review half ---------------------------------------------------------

/**
 * A listening review server bound to `home`, plus the renderer's own `apiClient` pointed at it.
 * The client is the real one out of `src/renderer`; only the two things a browser supplies for free
 * are injected — the token (which normally comes off the page URL) and `Sec-Fetch-Site`, which node's
 * `fetch` does not send and the server refuses mutations without.
 */
async function startReview(home: string, options: { uiFile?: string; compare?: string } = {}) {
  const settings = new SettingsStore(home)
  const workspace = new Workspace(settings, '0.1.0', () => 'now')
  await workspace.open(join(home, 'tickets.json'))
  const evalPath = join(home, 'review.qval.json')
  await workspace.save(evalPath)
  // What the CLI does before the browser exists: name the files on offer to merge, so the client
  // only ever sends an id back.
  if (options.compare) {
    workspace.setComparisonSources([{ id: 'c1', name: 'tickets.qval.json', path: options.compare }])
  }

  const server = createReviewServer({ workspace, settings, appVersion: '0.1.0', ...options })
  await server.listen()
  running.push(server)

  const api = createApiClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: server.token,
    fetchImpl: (input, init) =>
      fetch(input, {
        ...init,
        headers: { ...init?.headers, ...(init?.method === 'POST' ? { 'Sec-Fetch-Site': 'same-origin' } : {}) }
      })
  })

  return { api, server, workspace, evalPath }
}

const readEval = (path: string): EvalFile => {
  const file = normalizeEvalFile(JSON.parse(readFileSync(path, 'utf8')))
  if (!file) throw new Error(`${path} is not a valid eval file`)
  return file
}

// --- The round trip ----------------------------------------------------------

describe('skill file + browser file', () => {
  it('agree on both fingerprints and merge into a human-vs-LLM comparison', async () => {
    // Two separate working directories over the same dataset: the two-people case merging exists for.
    const skillHome = join(dir, 'skill')
    const reviewHome = join(dir, 'review')
    for (const home of [skillHome, reviewHome]) {
      await fs.mkdir(home, { recursive: true })
      await atomicWriteJson(join(home, 'tickets.json'), TICKETS)
    }

    const llmPath = runSkill(skillHome)
    const llmFile = readEval(llmPath)
    expect(llmFile.evaluators.find((e) => e.kind === 'llm')?.results).toHaveLength(3)

    const { api, workspace, evalPath } = await startReview(reviewHome, { compare: llmPath })

    // The browser sets up the same schema and rules, then scores by hand.
    await api.settings.set({ schema: SCHEMA, rules: RULES, evaluatorName: 'Ada' })
    for (const t of TICKETS) await api.human.setValues(t.id, HUMAN_VALUES)

    const humanFile = readEval(evalPath)
    const human = humanFile.evaluators.find((e) => e.kind === 'human')!
    expect(human.name).toBe('Ada')
    expect(human.results).toHaveLength(3)

    // The claim: independently produced, still the same dataset and the same criteria.
    expect(humanFile.meta.dataset.fingerprint).toBe(llmFile.meta.dataset.fingerprint)
    expect(humanFile.meta.config.fingerprint).toBe(llmFile.meta.config.fingerprint)

    // Which is exactly what MERGE gates on — through the client, by candidate id, no path on the wire.
    const snapshot = await api.session.mergeComparison('c1')
    expect(snapshot!.comparisons).toHaveLength(1)
    expect(snapshot!.candidates).toEqual([{ id: 'c1', name: 'tickets.qval.json', merged: true }])

    const agg = aggregateSession(
      workspace.currentWorkingFile()!,
      snapshot!.comparisons,
      TICKETS.map((t) => t.id)
    )
    const first = agg.byTicket[1]
    expect(first.llm.empathy).toMatchObject({ type: 'score', mean: 5, n: 1 })
    expect(first.human.empathy).toMatchObject({ type: 'score', mean: 4, n: 1 })
    // The headline number: `delta` is human minus LLM, and the model ran a point warmer than the
    // person on every ticket.
    expect(first.comparison.empathy).toMatchObject({ kind: 'score', llmMean: 5, humanMean: 4, delta: -1 })
    expect(first.comparison.resolved).toMatchObject({ kind: 'boolean', agree: true })
    expect(agg.rollup.empathy).toMatchObject({ kind: 'score', nTickets: 3, meanAbsDelta: 1 })
  })

  it('refuses to merge the same evaluation done under different rules', async () => {
    const skillHome = join(dir, 'skill')
    const reviewHome = join(dir, 'review')
    for (const home of [skillHome, reviewHome]) {
      await fs.mkdir(home, { recursive: true })
      await atomicWriteJson(join(home, 'tickets.json'), TICKETS)
    }
    const llmPath = runSkill(skillHome)

    const { api } = await startReview(reviewHome, { compare: llmPath })
    await api.settings.set({ schema: SCHEMA, rules: 'Score generously.\n' })

    // The refusal is a 409 carrying the reason, which is what the merge modal shows per row.
    await expect(api.session.mergeComparison('c1')).rejects.toThrow(/different scoring criteria/i)
  })
})

// --- The client/server contract ----------------------------------------------

describe('the renderer client against the real server', () => {
  it('reads the session it was bound to and persists an edit back into it', async () => {
    const home = join(dir, 'one')
    await fs.mkdir(home, { recursive: true })
    await atomicWriteJson(join(home, 'tickets.json'), TICKETS)
    const { api } = await startReview(home)

    expect(await api.app.getVersion()).toBe('0.1.0')

    const session = await api.session.loadLast()
    expect(session!.tickets.map((t) => t.id)).toEqual([1, 2, 3])

    await api.settings.set({ schema: SCHEMA, rules: RULES })
    expect((await api.settings.get()).rules).toBe(RULES)

    // Out of range on purpose: the server re-validates against the file's schema, so the client
    // cannot write a value the form itself would not allow.
    await api.human.setValues(2, { empathy: 99 })
    const after = await api.session.loadLast()
    const human = after!.workingFile.evaluators.find((e) => e.kind === 'human')!
    expect(human.results.find((r) => r.ticketId === 2)!.values).toEqual({ empathy: 5 })
  })

  it('reports the file it is bound to instead of pretending to save-as', async () => {
    const home = join(dir, 'two')
    await fs.mkdir(home, { recursive: true })
    await atomicWriteJson(join(home, 'tickets.json'), TICKETS)
    const { api, evalPath } = await startReview(home)

    expect(await api.session.save()).toBe(evalPath)
    // No candidates offered, so there is nothing to merge and the UI hides the affordance.
    expect((await api.session.loadLast())!.candidates).toEqual([])
  })

  it('exports the report beside the working file, with no destination from the browser', async () => {
    const home = join(dir, 'export')
    await fs.mkdir(home, { recursive: true })
    await atomicWriteJson(join(home, 'tickets.json'), TICKETS)
    const { api } = await startReview(home)

    await api.settings.set({ schema: SCHEMA, rules: RULES })
    await api.human.setValues(1, HUMAN_VALUES)

    const path = await api.session.exportReport()
    expect(path).toBe(join(home, 'review.report.json'))
    const report = JSON.parse(readFileSync(path!, 'utf8'))
    expect(report.meta.app).toBe('qval-report')
    expect(report.tickets).toHaveLength(3)
  })

  it('serves the committed UI bundle under a CSP that names its inline script', async () => {
    const home = join(dir, 'three')
    await fs.mkdir(home, { recursive: true })
    await atomicWriteJson(join(home, 'tickets.json'), TICKETS)
    const { server } = await startReview(home)

    const res = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { [TOKEN_HEADER]: server.token } })
    const html = await res.text()
    expect(res.status).toBe(200)
    // Self-contained: no stylesheet link, no script src, nothing to fetch from anywhere.
    expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i)
    expect(html).not.toMatch(/<script[^>]+\ssrc=/i)
    // The fonts the design depends on travel with it, inlined rather than assumed.
    expect((html.match(/data:font\/woff2/g) ?? []).length).toBe(4)

    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    expect(scripts).toHaveLength(1)
    const hash = createHash('sha256').update(scripts[0][1], 'utf8').digest('base64')
    expect(res.headers.get('content-security-policy')).toContain(`'sha256-${hash}'`)
  })
})

/** The bundle has to exist for the case above; a missing one is a build problem, not a test failure. */
it('has a committed UI bundle to serve', async () => {
  await expect(fs.stat(DEFAULT_UI_FILE)).resolves.toBeTruthy()
})
