// Port of src/shared/evalFile.ts (plus `mergeResults` from src/main/evaluation/orchestrator.ts),
// with zod replaced by plain guards. `normalizeEvalFile` reproduces the zod schema's *nested*
// `.catch()` behavior: a `.catch()` sits on the array, so one unparseable element empties the whole
// array (results, evaluators), while a missing required field (meta.app, either fingerprint) makes
// the whole file unreadable. Getting that wrong would let the engine write a file the app then
// silently strips.

import { normalizeSchema } from './schema.mjs'
import { normalizeRules } from './rules.mjs'
import { hasDrops } from './evalValidate.mjs'

/** Fixed evaluator ids for the working file's own two evaluators. */
export const LLM_EVALUATOR_ID = 'llm'
export const HUMAN_EVALUATOR_ID = 'human'

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// --- Construction ------------------------------------------------------------

/** Create a fresh, empty working file for a dataset + config. Evaluators are added by runs/edits. */
export function createWorkingFile(args) {
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
 * Merge a batch of LLM results into the file's own `llm` evaluator (creating it if absent),
 * upserting by `ticketId` and leaving both the results for other tickets and the `human` evaluator
 * untouched. Pure: returns a new file. `provider`/`model`/`name` are refreshed to the current run's.
 */
export function applyLlmResults(file, run) {
  const existing = file.evaluators.find((e) => e.id === LLM_EVALUATOR_ID && e.kind === 'llm')
  const byId = new Map((existing?.results ?? []).map((r) => [r.ticketId, r]))
  for (const r of run.results) byId.set(r.ticketId, r)
  const results = Array.from(byId.values()).sort((a, b) => a.ticketId - b.ticketId)

  const llm = {
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

/** Merge a first attempt with its retry: a value that validated on either attempt wins. */
export function mergeResults(a, b) {
  if (!b) return a
  const values = { ...b.values, ...a.values } // first attempt takes priority where both present
  const combined = [...(a.issues ?? []), ...(b.issues ?? [])].filter(
    (i) => !(i.action === 'dropped' && i.key in values)
  )
  const seen = new Set()
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

// --- Queries -----------------------------------------------------------------

/**
 * Whether a ticket's LLM result needs (re-)evaluation for the "remaining" run mode: never scored
 * (no result), a ticket-level error, or a value the model couldn't produce (dropped).
 */
export function needsAttention(result) {
  return !result || !!result.error || hasDrops(result.issues)
}

/** The `results` of the file's own evaluator of the given kind (`llm`/`human`), or `[]`. */
export function ownResults(file, kind) {
  const id = kind === 'llm' ? LLM_EVALUATOR_ID : HUMAN_EVALUATOR_ID
  return file.evaluators.find((e) => e.id === id && e.kind === kind)?.results ?? []
}

/** A result counts as "scored" once it carries at least one non-empty value (error/empty ≠ scored). */
export function isScoredResult(r) {
  return Object.keys(r.values).length > 0
}

/** How many tickets the file's own evaluator of `kind` has actually scored. */
export function evaluatedCount(file, kind) {
  return ownResults(file, kind).filter(isScoredResult).length
}

/** The provider/model the file's scored LLM evaluator was produced with (pins locked re-runs). */
export function lockedLlmProvider(file) {
  const llm = file.evaluators.find((e) => e.kind === 'llm' && e.results.some(isScoredResult))
  return llm ? { provider: llm.provider, model: llm.model } : null
}

// --- Normalization (the zod `fileSchema`, by hand) ----------------------------

/** `number | boolean | string | number[] | string[]` (arrays must be homogeneous). */
function parseEvalValue(v) {
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return { ok: true, value: v }
  if (Array.isArray(v) && (v.every((x) => typeof x === 'number') || v.every((x) => typeof x === 'string'))) {
    return { ok: true, value: v }
  }
  return { ok: false }
}

/** `z.record(evalValueSchema).catch({})`: one bad value empties the whole values map. */
function parseValues(raw) {
  if (!isObject(raw)) return {}
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    const parsed = parseEvalValue(v)
    if (!parsed.ok) return {}
    out[k] = parsed.value
  }
  return out
}

const ISSUE_ACTIONS = ['clamped', 'coerced', 'dropped']

/** `z.array(issueSchema).optional()`: no `.catch()`, so a bad issue fails the whole result. */
function parseIssues(raw) {
  if (!Array.isArray(raw)) return { ok: false }
  const out = []
  for (const i of raw) {
    if (!isObject(i) || typeof i.key !== 'string' || !ISSUE_ACTIONS.includes(i.action)) return { ok: false }
    out.push('original' in i ? { key: i.key, action: i.action, original: i.original } : { key: i.key, action: i.action })
  }
  return { ok: true, value: out }
}

/** One result, or a failure that empties its evaluator's whole `results` array. */
function parseResult(raw) {
  if (!isObject(raw)) return { ok: false }
  if (typeof raw.ticketId !== 'number' || !Number.isInteger(raw.ticketId)) return { ok: false }
  const out = {
    ticketId: raw.ticketId,
    values: parseValues(raw.values),
    evaluatedAt: typeof raw.evaluatedAt === 'string' ? raw.evaluatedAt : ''
  }
  if ('error' in raw && raw.error !== undefined) {
    if (raw.error !== null && typeof raw.error !== 'string') return { ok: false }
    out.error = raw.error
  }
  if ('issues' in raw && raw.issues !== undefined) {
    const issues = parseIssues(raw.issues)
    if (!issues.ok) return { ok: false }
    out.issues = issues.value
  }
  return { ok: true, value: out }
}

/** One evaluator, or a failure that empties the file's whole `evaluators` array. */
function parseEvaluator(raw) {
  if (!isObject(raw)) return { ok: false }
  if (typeof raw.id !== 'string' || raw.id.length < 1) return { ok: false }
  if (raw.kind !== 'llm' && raw.kind !== 'human') return { ok: false }
  const out = { id: raw.id, kind: raw.kind, name: typeof raw.name === 'string' ? raw.name : '' }
  if ('provider' in raw && raw.provider !== undefined) {
    if (typeof raw.provider !== 'string') return { ok: false }
    out.provider = raw.provider
  }
  if ('model' in raw && raw.model !== undefined) {
    if (typeof raw.model !== 'string') return { ok: false }
    out.model = raw.model
  }
  out.results = parseResultList(raw.results)
  return { ok: true, value: out }
}

function parseResultList(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    const parsed = parseResult(item)
    if (!parsed.ok) return [] // `.catch([])` sits on the array, not the element
    out.push(parsed.value)
  }
  return out
}

/** `z.object({provider?, model?}).nullable().catch(null)`. */
function parseDatasetSource(raw) {
  if (!isObject(raw)) return null
  const out = {}
  if ('provider' in raw && raw.provider !== undefined) {
    if (typeof raw.provider !== 'string') return null
    out.provider = raw.provider
  }
  if ('model' in raw && raw.model !== undefined) {
    if (typeof raw.model !== 'string') return null
    out.model = raw.model
  }
  return out
}

/**
 * Normalize a loaded eval file, or return `null` if it isn't a valid Qval file. Drops evaluator
 * results whose `ticketId` isn't unique within that evaluator, and normalizes the config snapshot.
 */
export function normalizeEvalFile(raw) {
  if (!isObject(raw) || !isObject(raw.meta)) return null
  const meta = raw.meta
  if (meta.app !== 'qval') return null
  if (!isObject(meta.dataset) || typeof meta.dataset.fingerprint !== 'string') return null
  if (!isObject(meta.config) || typeof meta.config.fingerprint !== 'string') return null

  let evaluators = []
  if (Array.isArray(raw.evaluators)) {
    for (const item of raw.evaluators) {
      const parsed = parseEvaluator(item)
      if (!parsed.ok) {
        evaluators = [] // `.catch([])` on the array
        break
      }
      evaluators.push(parsed.value)
    }
  }

  const deduped = evaluators.map((e) => {
    const seen = new Set()
    const results = e.results.filter((r) => (seen.has(r.ticketId) ? false : (seen.add(r.ticketId), true)))
    return { ...e, results }
  })

  return {
    meta: {
      app: 'qval',
      appVersion: typeof meta.appVersion === 'string' ? meta.appVersion : '0.0.0',
      createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : '',
      updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : '',
      dataset: {
        fingerprint: meta.dataset.fingerprint,
        ticketCount:
          typeof meta.dataset.ticketCount === 'number' && !Number.isNaN(meta.dataset.ticketCount)
            ? meta.dataset.ticketCount
            : 0,
        source: parseDatasetSource(meta.dataset.source)
      },
      config: {
        fingerprint: meta.config.fingerprint,
        schema: normalizeSchema(meta.config.schema),
        rules: normalizeRules(meta.config.rules)
      }
    },
    evaluators: deduped
  }
}
