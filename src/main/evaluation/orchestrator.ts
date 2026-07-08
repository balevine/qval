import type { EvalResult, EvalSchema, EvaluationProgress, Ticket } from '@shared/types'
import { compilePrompt } from '@shared/promptCompiler'
import { validateValues, hasDrops } from '@shared/evalValidate'
import { maxOutputTokensForBatch, MAX_OUTPUT_TOKENS_CEILING } from '@shared/evaluation'
import {
  ProviderError,
  TruncationError,
  type GenerateBatchResult,
  type LLMProvider
} from './providers'

export interface RunEvaluationDeps {
  provider: LLMProvider
  schema: EvalSchema
  rules: string
  /** The target tickets to evaluate this run. */
  tickets: Ticket[]
  signal: AbortSignal
  onProgress?: (p: EvaluationProgress) => void
  /** Called after each batch with all results so far (for incremental persistence). */
  onResults?: (results: EvalResult[]) => Promise<void> | void
  batchSize?: number
  concurrency?: number
  maxRetries?: number
  rng?: () => number
  now?: () => string
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface RunEvaluationResult {
  results: EvalResult[]
  retries: number
  failed: number
  cancelled: boolean
  usage: { inputTokens: number; outputTokens: number }
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1))
}
export function backoffWithJitter(attempt: number, rng: () => number): number {
  return Math.round(backoffMs(attempt) * (1 + rng() * 0.25))
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

interface BatchArgs {
  compiledPrompt: string
  staticPrefix: string
  dynamicSuffix: string
  count: number
  maxOutputTokens: number
}

/** Retry transient failures; on truncation grow `max_tokens`, then give up so the caller splits. */
async function generateWithRetry(
  provider: LLMProvider,
  args: BatchArgs,
  signal: AbortSignal,
  maxRetries: number,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  rng: () => number,
  onRetry: () => void,
  onToken: (info: { outputTokens: number }) => void
): Promise<GenerateBatchResult> {
  let attempt = 0
  let maxOutputTokens = args.maxOutputTokens
  for (;;) {
    try {
      return await provider.generateBatch({ ...args, maxOutputTokens, signal, onToken })
    } catch (err) {
      if (signal.aborted) throw err
      if (err instanceof TruncationError) {
        if (maxOutputTokens < MAX_OUTPUT_TOKENS_CEILING && attempt < maxRetries) {
          maxOutputTokens = Math.min(MAX_OUTPUT_TOKENS_CEILING, Math.ceil(maxOutputTokens * 1.5))
          attempt++
          onRetry()
          await sleep(backoffWithJitter(attempt, rng), signal)
          if (signal.aborted) throw err
          continue
        }
        throw err
      }
      const canRetry = err instanceof ProviderError ? err.retryable : true
      if (!canRetry || attempt >= maxRetries) throw err
      attempt++
      onRetry()
      await sleep(backoffWithJitter(attempt, rng), signal)
      if (signal.aborted) throw err
    }
  }
}

/** Split tickets into fixed-size batches. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

/**
 * Evaluate `tickets` in concurrent, retrying batches. Each ticket's values are validated/repaired
 * against the schema (spec §6); a ticket the model omits or a failed batch yields an `error`
 * result (no silent gaps). Tickets with an error or a dropped value get **one** automatic
 * validation retry, merged field-by-field (cleaner wins). Streams progress, persists incrementally
 * via `onResults`, and stops cleanly on abort.
 */
export async function runEvaluation(deps: RunEvaluationDeps): Promise<RunEvaluationResult> {
  const { provider, schema, rules, signal } = deps
  const batchSize = Math.max(1, deps.batchSize ?? 10)
  const concurrency = Math.max(1, deps.concurrency ?? 4)
  const maxRetries = deps.maxRetries ?? 6
  const rng = deps.rng ?? Math.random
  const sleep = deps.sleep ?? abortableSleep
  const now = deps.now ?? (() => new Date().toISOString())

  const total = deps.tickets.length
  const batches = chunk(deps.tickets, batchSize)
  // Total scheduled batches. Grows when the validation-retry pass (below) queues more work, so a
  // retried batch counts as "done" only once it actually completes and `batchesDone` never exceeds
  // `batchesTotal`.
  let totalBatches = batches.length

  const results = new Map<number, EvalResult>()
  let inputTokens = 0
  let outputTokens = 0
  let processedBatches = 0
  let retries = 0
  const active = new Map<number, { streamed: number; target: number; count: number }>()

  const failedCount = () => {
    let n = 0
    for (const r of results.values()) if (r.error) n++
    return n
  }

  const emit = () => {
    let streamingTokens = 0
    let inflight = 0
    for (const a of active.values()) {
      streamingTokens += a.streamed
      inflight += (a.target > 0 ? Math.min(0.99, a.streamed / a.target) : 0) * a.count
    }
    const fraction = total > 0 ? Math.min(1, (results.size + inflight) / total) : 1
    deps.onProgress?.({
      ticketsDone: results.size,
      ticketsTotal: total,
      batchesDone: processedBatches,
      batchesTotal: totalBatches,
      retries,
      failed: failedCount(),
      streamingTokens,
      fraction
    })
  }

  const buildResult = (t: Ticket, map: Record<string, unknown>): EvalResult => {
    const raw = map[String(t.id)]
    if (raw === undefined) {
      return { ticketId: t.id, values: {}, evaluatedAt: now(), error: 'Model did not return a result for this ticket.' }
    }
    const { values, issues } = validateValues(raw, schema)
    return { ticketId: t.id, values, evaluatedAt: now(), error: null, ...(issues.length ? { issues } : {}) }
  }

  let batchKey = 0
  // Evaluate one batch of tickets into `sink`; split in half on truncation, mark errors otherwise.
  const collect = async (batchTickets: Ticket[], sink: Map<number, EvalResult>): Promise<void> => {
    if (signal.aborted || batchTickets.length === 0) return
    const count = batchTickets.length
    const compiled = compilePrompt({ rules, schema, tickets: batchTickets })
    const key = batchKey++
    active.set(key, { streamed: 0, target: maxOutputTokensForBatch(count, schema), count })
    try {
      const { raw, usage } = await generateWithRetry(
        provider,
        {
          compiledPrompt: compiled.full,
          staticPrefix: compiled.staticPrefix,
          dynamicSuffix: compiled.dynamicSuffix,
          count,
          maxOutputTokens: maxOutputTokensForBatch(count, schema)
        },
        signal,
        maxRetries,
        sleep,
        rng,
        () => {
          retries++
        },
        ({ outputTokens: streamed }) => {
          const a = active.get(key)
          if (a) a.streamed = streamed
          emit()
        }
      )
      inputTokens += usage.inputTokens
      outputTokens += usage.outputTokens
      const map = asRecord(raw)
      for (const t of batchTickets) sink.set(t.id, buildResult(t, map))
    } catch (err) {
      if (err instanceof TruncationError && count > 1 && !signal.aborted) {
        const half = Math.floor(count / 2)
        active.delete(key)
        await collect(batchTickets.slice(0, half), sink)
        await collect(batchTickets.slice(half), sink)
        return
      }
      if (!signal.aborted) {
        const message = err instanceof Error ? err.message : String(err)
        for (const t of batchTickets) sink.set(t.id, { ticketId: t.id, values: {}, evaluatedAt: now(), error: message })
      }
    } finally {
      active.delete(key)
    }
  }

  // Run a list of batches through a concurrency pool, persisting after each.
  const runBatches = async (list: Ticket[][], sink: Map<number, EvalResult>): Promise<void> => {
    let idx = 0
    const worker = async (): Promise<void> => {
      while (idx < list.length) {
        if (signal.aborted) return
        const batch = list[idx++]
        await collect(batch, sink)
        processedBatches++
        // Mirror the sink into the results view + persist incrementally.
        for (const [id, r] of sink) results.set(id, r)
        if (deps.onResults) {
          try {
            await deps.onResults(Array.from(results.values()))
          } catch {
            /* persistence failures never abort a run */
          }
        }
        emit()
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker))
  }

  emit()
  // Pass 1: evaluate everything.
  await runBatches(batches, results)

  // Pass 2 (single): re-evaluate tickets that errored or had a dropped value, merged cleaner-wins.
  if (!signal.aborted) {
    const retryTickets = deps.tickets.filter((t) => {
      const r = results.get(t.id)
      return r && (r.error || hasDrops(r.issues))
    })
    if (retryTickets.length > 0) {
      // Snapshot the first-attempt results before the retry pass runs — `runBatches` mirrors its
      // sink into `results`, so without this the retry would overwrite the very values the merge
      // needs to compare against, silently discarding a value the first attempt got right (§6).
      const firstPass = new Map(retryTickets.map((t) => [t.id, results.get(t.id)!]))
      const retryBatches = chunk(retryTickets, batchSize)
      totalBatches += retryBatches.length // the retry pass is real additional batch work
      const retrySink = new Map<number, EvalResult>()
      await runBatches(retryBatches, retrySink)
      for (const t of retryTickets) {
        const merged = mergeResults(firstPass.get(t.id)!, retrySink.get(t.id), schema)
        results.set(t.id, merged)
      }
      emit()
    }
  }

  return {
    results: Array.from(results.values()).sort((a, b) => a.ticketId - b.ticketId),
    retries,
    failed: failedCount(),
    cancelled: signal.aborted,
    usage: { inputTokens, outputTokens }
  }
}

/** Merge a first attempt with its retry: a value that validated on either attempt wins (§6). */
export function mergeResults(a: EvalResult, b: EvalResult | undefined, _schema: EvalSchema): EvalResult {
  if (!b) return a
  const values = { ...b.values, ...a.values } // first attempt takes priority where both present
  const combined = [...(a.issues ?? []), ...(b.issues ?? [])].filter(
    (i) => !(i.action === 'dropped' && i.key in values)
  )
  const seen = new Set<string>()
  const issues = combined.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)))
  const hasValues = Object.keys(values).length > 0
  return {
    ticketId: a.ticketId,
    values,
    evaluatedAt: a.evaluatedAt,
    error: hasValues ? null : (a.error ?? b.error ?? null),
    ...(issues.length ? { issues } : {})
  }
}
