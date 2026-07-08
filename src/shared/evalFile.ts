import { z } from 'zod'
import type {
  ConfigSnapshot,
  DatasetRef,
  EvalFile,
  EvalResult,
  EvalValues,
  Evaluator,
  EvaluatorKind
} from './types'
import { normalizeSchema } from './schema'
import { normalizeRules } from './rules'
import { hasDrops } from './evalValidate'
import { enumFrom } from './zodUtil'

/** Fixed evaluator ids for the working file's own two evaluators. */
export const LLM_EVALUATOR_ID = 'llm'
export const HUMAN_EVALUATOR_ID = 'human'

/**
 * The eval-file model (spec §2.4): create a fresh working file, and tolerantly normalize a loaded
 * `*.qval.json`. The file lists **evaluators** (each with a `kind`, name, and sparse `results[]`)
 * and references the dataset by fingerprint. Pure — main and renderer share it.
 */

/** Create a fresh, empty working file for a dataset + config. Evaluators are added by runs/edits. */
export function createWorkingFile(args: {
  appVersion: string
  now: string
  dataset: DatasetRef
  config: ConfigSnapshot
}): EvalFile {
  return {
    meta: {
      app: 'qval',
      appVersion: args.appVersion,
      createdAt: args.now,
      updatedAt: args.now,
      dataset: args.dataset,
      config: args.config
    },
    evaluators: []
  }
}

/**
 * Merge a batch of LLM results into the working file's own `llm` evaluator (creating it if absent),
 * upserting by `ticketId` and leaving results for other tickets untouched (spec §6 re-run modes).
 * Pure — returns a new file. `provider`/`model`/`name` are refreshed to the current run's.
 */
export function applyLlmResults(
  file: EvalFile,
  run: { provider: string; model: string; results: EvalResult[] }
): EvalFile {
  const existing = file.evaluators.find((e) => e.id === LLM_EVALUATOR_ID && e.kind === 'llm')
  const byId = new Map<number, EvalResult>((existing?.results ?? []).map((r) => [r.ticketId, r]))
  for (const r of run.results) byId.set(r.ticketId, r)
  const results = Array.from(byId.values()).sort((a, b) => a.ticketId - b.ticketId)

  const llm: Evaluator = {
    id: LLM_EVALUATOR_ID,
    kind: 'llm',
    name: `LLM · ${run.model}`,
    provider: run.provider,
    model: run.model,
    results
  }
  const others = file.evaluators.filter((e) => e.id !== LLM_EVALUATOR_ID)
  return { ...file, evaluators: [llm, ...others] }
}

/**
 * Upsert one ticket's **human** values into the working file's own `human` evaluator (creating it
 * if absent), replacing that ticket's values with `values` and leaving other tickets untouched
 * (spec §7). An empty `values` ({}) removes the ticket's human result ("not evaluated"). Pure.
 */
export function applyHumanValues(
  file: EvalFile,
  args: { name: string; ticketId: number; values: EvalValues; now: string }
): EvalFile {
  const existing = file.evaluators.find((e) => e.id === HUMAN_EVALUATOR_ID && e.kind === 'human')
  const byId = new Map<number, EvalResult>((existing?.results ?? []).map((r) => [r.ticketId, r]))
  if (Object.keys(args.values).length > 0) {
    byId.set(args.ticketId, { ticketId: args.ticketId, values: args.values, evaluatedAt: args.now })
  } else {
    byId.delete(args.ticketId)
  }
  const results = Array.from(byId.values()).sort((a, b) => a.ticketId - b.ticketId)

  const human: Evaluator = {
    id: HUMAN_EVALUATOR_ID,
    kind: 'human',
    name: args.name || existing?.name || 'Me',
    results
  }
  const others = file.evaluators.filter((e) => e.id !== HUMAN_EVALUATOR_ID)
  return { ...file, evaluators: [...others, human] }
}

/**
 * Whether a ticket's LLM result needs (re-)evaluation for the "needs attention" run mode (§6):
 * never scored (no result), a ticket-level error, or a value the model couldn't produce (dropped).
 * Shared by the run-target selection (main) and the modal's target count (renderer) so they agree.
 */
export function needsAttention(result: EvalResult | undefined): boolean {
  return !result || !!result.error || hasDrops(result.issues)
}

/** The `results` of the file's own evaluator of the given kind (`llm`/`human`), or `[]`. */
export function ownResults(file: EvalFile, kind: EvaluatorKind): EvalResult[] {
  const id = kind === 'llm' ? LLM_EVALUATOR_ID : HUMAN_EVALUATOR_ID
  return file.evaluators.find((e) => e.id === id && e.kind === kind)?.results ?? []
}

/**
 * How many tickets the file's own evaluator of `kind` has actually scored (≥1 non-empty value).
 * A ticket that errored or had every value dropped counts as *unscored* — the same definition for
 * both streams, so the LLM and human completeness stats are consistent.
 */
export function evaluatedCount(file: EvalFile, kind: EvaluatorKind): number {
  return ownResults(file, kind).filter((r) => Object.keys(r.values).length > 0).length
}

/** How many tickets the file's human evaluator has scored (non-empty values). */
export function humanEvaluatedCount(file: EvalFile): number {
  return evaluatedCount(file, 'human')
}

// --- Config lock (spec §3/§4) ------------------------------------------------
// A file's config (schema + rules) and the model that produced it are frozen once real scores
// exist, so the file's snapshot/fingerprint can never disagree with how its data was produced.
// The escape hatch is re-opening the tickets.json, which starts a fresh (unlocked) working file.

/** A result counts as "scored" once it carries at least one non-empty value (error/empty ≠ scored). */
export function isScoredResult(r: EvalResult): boolean {
  return Object.keys(r.values).length > 0
}

/**
 * Schema + rules are frozen once ANY evaluator (llm or human) has scored a ticket: the criteria
 * must stay identical across both streams and every ticket for the config fingerprint to stay
 * honest. Empty / error-only files stay editable so the schema can be set up before the first score.
 */
export function configLocked(file: EvalFile | null | undefined): boolean {
  return !!file && file.evaluators.some((e) => e.results.some(isScoredResult))
}

/**
 * Provider + model are frozen once the **LLM** evaluator has scored a ticket — one model must score
 * every ticket in a run (no finishing an Ollama run with Anthropic). Implies `configLocked`.
 */
export function providerLocked(file: EvalFile | null | undefined): boolean {
  return (
    !!file && file.evaluators.some((e) => e.kind === 'llm' && e.results.some(isScoredResult))
  )
}

/** The provider/model the file's scored LLM evaluator was produced with (to pin locked re-runs). */
export function lockedLlmProvider(file: EvalFile): { provider?: string; model?: string } | null {
  const llm = file.evaluators.find((e) => e.kind === 'llm' && e.results.some(isScoredResult))
  return llm ? { provider: llm.provider, model: llm.model } : null
}

/** Quick structural guess (before full parse) — is this JSON a Qval eval file vs a tickets file? */
export function looksLikeEvalFile(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as { meta?: { app?: unknown }; evaluators?: unknown }
  return r.meta?.app === 'qval' || Array.isArray(r.evaluators)
}

// --- Zod schema for a loaded file (tolerant, but rejects non-Qval JSON) -------

const evalValueSchema = z.union([
  z.number(),
  z.boolean(),
  z.string(),
  z.array(z.number()),
  z.array(z.string())
])

const resultSchema = z.object({
  ticketId: z.number().int(),
  values: z.record(evalValueSchema).catch({}),
  evaluatedAt: z.string().catch(''),
  error: z.string().nullable().optional(),
  issues: z
    .array(z.object({ key: z.string(), action: z.enum(['clamped', 'coerced', 'dropped']), original: z.unknown() }))
    .optional()
})

const evaluatorSchema = z.object({
  id: z.string().min(1),
  kind: enumFrom(['llm', 'human'] as const),
  name: z.string().catch(''),
  provider: z.string().optional(),
  model: z.string().optional(),
  results: z.array(resultSchema).catch([])
})

const fileSchema = z.object({
  meta: z.object({
    app: z.literal('qval'),
    appVersion: z.string().catch('0.0.0'),
    createdAt: z.string().catch(''),
    updatedAt: z.string().catch(''),
    dataset: z.object({
      fingerprint: z.string(),
      ticketCount: z.number().catch(0),
      source: z.object({ provider: z.string().optional(), model: z.string().optional() }).nullable().catch(null)
    }),
    config: z.object({
      fingerprint: z.string(),
      schema: z.unknown(),
      rules: z.unknown()
    })
  }),
  evaluators: z.array(evaluatorSchema).catch([])
})

/**
 * Normalize a loaded eval file, or return `null` if it isn't a valid Qval file. Drops evaluator
 * results whose `ticketId` isn't unique within that evaluator, and normalizes the config snapshot.
 */
export function normalizeEvalFile(raw: unknown): EvalFile | null {
  const parsed = fileSchema.safeParse(raw)
  if (!parsed.success) return null
  const d = parsed.data

  const evaluators: Evaluator[] = d.evaluators.map((e) => {
    const seen = new Set<number>()
    const results = e.results.filter((r) => (seen.has(r.ticketId) ? false : (seen.add(r.ticketId), true)))
    return { ...e, results }
  })

  return {
    meta: {
      app: 'qval',
      appVersion: d.meta.appVersion,
      createdAt: d.meta.createdAt,
      updatedAt: d.meta.updatedAt,
      dataset: {
        fingerprint: d.meta.dataset.fingerprint,
        ticketCount: d.meta.dataset.ticketCount,
        source: d.meta.dataset.source
      },
      config: {
        fingerprint: d.meta.config.fingerprint,
        schema: normalizeSchema(d.meta.config.schema),
        rules: normalizeRules(d.meta.config.rules)
      }
    },
    evaluators
  }
}
