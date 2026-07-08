import { describe, expect, it } from 'vitest'
import { mergeResults, runEvaluation } from './orchestrator'
import { TruncationError, type GenerateBatchArgs, type GenerateBatchResult, type LLMProvider } from './providers'
import type { EvalResult, EvaluationProgress, EvalSchema, Ticket } from '@shared/types'

const schema: EvalSchema = [
  { key: 'empathy', label: 'Empathy', type: 'score', min: 1, max: 5, step: 1 },
  { key: 'category', label: 'Category', type: 'enum', options: ['bug', 'billing'] }
]

const tickets: Ticket[] = [1, 2, 3].map((id) => ({
  id,
  subject: `S${id}`,
  status: 'open',
  messages: [{ from: { name: 'C', email: 'c@x.com' }, body: 'help', isStaff: false, createdAt: 't' }]
}))

/** Fake provider that reads the ticket ids from the compiled prompt and answers via `responder`. */
class FakeProvider implements LLMProvider {
  readonly id = 'anthropic' as const
  readonly model = 'test-model'
  calls = 0
  constructor(private readonly responder: (ids: number[], call: number) => unknown) {}
  async generateBatch(args: GenerateBatchArgs): Promise<GenerateBatchResult> {
    const ids = [...args.dynamicSuffix!.matchAll(/### Ticket (\d+):/g)].map((m) => Number(m[1]))
    const raw = this.responder(ids, this.calls++)
    if (raw instanceof Error) throw raw
    return { raw, usage: { inputTokens: 10, outputTokens: 5 } }
  }
}

const deps = (provider: LLMProvider, over = {}) => ({
  provider,
  schema,
  rules: 'r',
  tickets,
  signal: new AbortController().signal,
  now: () => 't',
  sleep: () => Promise.resolve(),
  rng: () => 0,
  concurrency: 1,
  batchSize: 10,
  maxRetries: 1,
  ...over
})

describe('runEvaluation', () => {
  it('validates each ticket and reports no failures when all are answered', async () => {
    const p = new FakeProvider((ids) => Object.fromEntries(ids.map((id) => [id, { empathy: 4, category: 'bug' }])))
    const res = await runEvaluation(deps(p))
    expect(res.results.map((r) => r.ticketId)).toEqual([1, 2, 3])
    expect(res.results.every((r) => !r.error)).toBe(true)
    expect(res.failed).toBe(0)
  })

  it('marks an omitted ticket as errored, then recovers it on the single validation retry', async () => {
    // First call omits ticket 2; the retry pass (call #1, just ticket 2) includes it.
    const p = new FakeProvider((ids, call) =>
      Object.fromEntries(
        ids.filter((id) => !(call === 0 && id === 2)).map((id) => [id, { empathy: 3, category: 'billing' }])
      )
    )
    const res = await runEvaluation(deps(p))
    const t2 = res.results.find((r) => r.ticketId === 2)!
    expect(t2.error).toBeNull()
    expect(t2.values.empathy).toBe(3)
    expect(res.failed).toBe(0)
  })

  it('keeps a first-attempt value the retry regresses (first attempt wins across the retry pass)', async () => {
    // Pass 1: ticket 2 gets a good empathy but an invalid category (dropped → eligible for retry).
    // Retry: ticket 2 returns a *different* empathy and a valid category. The good pass-1 empathy
    // must survive (spec §6 "a value that validates on either attempt wins; first takes priority").
    const p = new FakeProvider((ids, call) =>
      Object.fromEntries(
        ids.map((id) => {
          if (id === 2) {
            return call === 0
              ? [id, { empathy: 4, category: 'nope' }] // category invalid → dropped, empathy kept
              : [id, { empathy: 1, category: 'bug' }] // retry regresses empathy, supplies category
          }
          return [id, { empathy: 3, category: 'billing' }]
        })
      )
    )
    const res = await runEvaluation(deps(p))
    const t2 = res.results.find((r) => r.ticketId === 2)!
    expect(t2.values.empathy).toBe(4) // pass-1's good value wins, not the retry's 1
    expect(t2.values.category).toBe('bug') // retry fills the gap it left
    expect(t2.error).toBeNull()
  })

  it('keeps batchesDone ≤ batchesTotal, growing the total to cover the validation-retry pass', async () => {
    // Omit ticket 2 on the first call → it errors → the retry pass schedules one more batch.
    const p = new FakeProvider((ids, call) =>
      Object.fromEntries(
        ids.filter((id) => !(call === 0 && id === 2)).map((id) => [id, { empathy: 3, category: 'billing' }])
      )
    )
    const events: EvaluationProgress[] = []
    await runEvaluation(deps(p, { onProgress: (e: EvaluationProgress) => events.push(e) }))

    expect(events.length).toBeGreaterThan(0)
    for (const e of events) expect(e.batchesDone).toBeLessThanOrEqual(e.batchesTotal) // never exceeds
    const last = events[events.length - 1]
    expect(last.batchesTotal).toBe(2) // 1 pass-1 batch (3 tickets @ batchSize 10) + 1 retry batch
    expect(last.batchesDone).toBe(2) // ends exactly complete
  })

  it('splits a batch in half when the model truncates', async () => {
    // Truncate on multi-ticket batches; answer single-ticket batches.
    const p = new FakeProvider((ids) =>
      ids.length > 1 ? new TruncationError('anthropic') : { [ids[0]]: { empathy: 5, category: 'bug' } }
    )
    const res = await runEvaluation(deps(p, { tickets: tickets.slice(0, 2), batchSize: 2 }))
    expect(res.results.map((r) => r.ticketId).sort()).toEqual([1, 2])
    expect(res.results.every((r) => r.values.empathy === 5)).toBe(true)
  })
})

describe('mergeResults', () => {
  it('fills a value dropped in the first attempt from the retry (cleaner wins)', () => {
    const first: EvalResult = { ticketId: 1, values: { empathy: 4 }, evaluatedAt: 't', error: null, issues: [{ key: 'category', action: 'dropped' }] }
    const retry: EvalResult = { ticketId: 1, values: { empathy: 2, category: 'bug' }, evaluatedAt: 't2', error: null }
    const merged = mergeResults(first, retry, schema)
    expect(merged.values).toEqual({ empathy: 4, category: 'bug' }) // first wins where both present; retry fills the gap
    expect(merged.issues).toBeUndefined()
  })

  it('clears a ticket-level error when the retry produced values', () => {
    const first: EvalResult = { ticketId: 1, values: {}, evaluatedAt: 't', error: 'omitted' }
    const retry: EvalResult = { ticketId: 1, values: { empathy: 3 }, evaluatedAt: 't2', error: null }
    expect(mergeResults(first, retry, schema).error).toBeNull()
  })
})
