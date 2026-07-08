/**
 * Shared types used across the main, preload, and renderer processes.
 *
 * This file is the single source of truth for the IPC contract and the persisted data model.
 * See `.plans/PROJECT_SPEC.md` for the full design. Phases add to it incrementally; the ticket /
 * eval-file / aggregate types arrive with their phases.
 */

// --- Providers ---------------------------------------------------------------

/**
 * Supported LLM providers. Ollama is local; Anthropic is hosted (needs an API key).
 * (OpenAI and Gemini are intentionally out of scope for now — see the spec.)
 */
export type ProviderId = 'ollama' | 'anthropic'

export const ALL_PROVIDERS: ProviderId[] = ['ollama', 'anthropic']
export const HOSTED_PROVIDERS: ProviderId[] = ['anthropic']
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  ollama: 'Ollama (local)',
  anthropic: 'Anthropic'
}

export function isHostedProvider(id: ProviderId): boolean {
  return HOSTED_PROVIDERS.includes(id)
}

// --- Eval schema (the user-defined output properties, spec §2.2) -------------

/** Base value type of an output property. `multiple` (below) turns any of these into an array. */
export type PropertyType = 'score' | 'boolean' | 'enum' | 'text'

/** Base types that may be made multi-valued (`multiple: true`). Boolean and text are single-value. */
export const MULTIPLE_ALLOWED: PropertyType[] = ['score', 'enum']

/** One typed output property the evaluator (LLM or human) fills in per ticket. */
export interface EvalProperty {
  /** Stable camelCase id used as the values-map key (e.g. "empathy"). */
  key: string
  /** Display name (e.g. "Empathy"). */
  label: string
  type: PropertyType
  /** When true, the value is an ARRAY of `type` (multi-select). Default false. */
  multiple?: boolean
  /** Guidance shown to the human AND injected into the LLM prompt. */
  description?: string
  // type === 'score':
  min?: number
  max?: number
  step?: number
  // type === 'enum':
  options?: string[]
}

export type EvalSchema = EvalProperty[]

/** Free-form evaluation context (prose, definitions, and/or a criteria list). */
export type Rules = string

// --- Tickets (the imported dataset, from Qbort — spec §2.1) ------------------

export const TICKET_STATUSES = ['new', 'open', 'pending', 'on-hold', 'solved', 'closed'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

/** Author of a message. Staff authors are on the company.biz domain (Qbort's convention). */
export interface TicketAuthor {
  name: string
  email: string
}

/** One message in a ticket conversation. `messages[0]` is the customer's opening message. */
export interface TicketMessage {
  from: TicketAuthor
  body: string
  isStaff: boolean
  /** ISO 8601 timestamp. */
  createdAt: string
}

/** A support ticket under evaluation. Qval consumes Qbort's shape and never mutates it. */
export interface Ticket {
  id: number
  subject: string
  status: TicketStatus
  messages: TicketMessage[]
}

// --- Eval file (`*.qval.json`, spec §2.4) ------------------------------------

export type EvaluatorKind = 'llm' | 'human'

/** A single scored value. Array forms are for `multiple` properties. */
export type EvalValue = number | boolean | string | number[] | string[]

/** The per-ticket values map (partial: a missing key = "that property not scored"). */
export type EvalValues = Partial<Record<string, EvalValue>>

/** Non-silent repair trail: what validation coerced or dropped for a value (spec §2.4/§6). */
export interface EvalIssue {
  key: string
  action: 'clamped' | 'coerced' | 'dropped'
  /** The pre-repair value (advisory; may be absent on older/loaded files). */
  original?: unknown
}

/** One evaluator's scores for one ticket. `results` is sparse — only scored tickets appear. */
export interface EvalResult {
  ticketId: number
  values: EvalValues
  evaluatedAt: string
  /** Non-null when the whole ticket failed (llm only). */
  error?: string | null
  issues?: EvalIssue[]
}

/** An independent scorer of the dataset (the LLM run, or a named human). */
export interface Evaluator {
  /** Stable id, unique within the file. */
  id: string
  /** Drives stream separation & aggregation — never inferred from `name`. */
  kind: EvaluatorKind
  /** Display label (the human name comes from the run config). */
  name: string
  provider?: string
  model?: string
  results: EvalResult[]
}

/** The dataset an eval file references (by fingerprint — tickets are not embedded, spec §10). */
export interface DatasetRef {
  fingerprint: string
  ticketCount: number
  source: { provider?: string; model?: string } | null
}

/** Snapshot of the config the evaluators used (its fingerprint gates merge). */
export interface ConfigSnapshot {
  fingerprint: string
  schema: EvalSchema
  rules: string
}

export interface EvalFileMeta {
  app: 'qval'
  appVersion: string
  createdAt: string
  updatedAt: string
  dataset: DatasetRef
  config: ConfigSnapshot
}

/** The on-disk eval file: a list of evaluators + the config/dataset snapshot. */
export interface EvalFile {
  meta: EvalFileMeta
  evaluators: Evaluator[]
}

/** A read-only comparison eval file added via MERGE (its evaluators are pooled into aggregates). */
export interface ComparisonFile {
  /** Stable id (its file path). */
  id: string
  /** Display label (filename). */
  name: string
  evaluators: Evaluator[]
}

/** The in-memory working session: the loaded dataset + the editable working file + merged files. */
export interface SessionSnapshot {
  tickets: Ticket[]
  workingFile: EvalFile
  /** Path the working file was opened from / last saved to; null when unsaved. */
  workingPath: string | null
  /** Read-only files added via MERGE, pooled into the aggregates/comparison (spec §8). */
  comparisons: ComparisonFile[]
}

// --- Aggregates & comparison (derived at merge time — spec §2.6) --------------

/** Per ticket, per property, per stream: the pooled result of all evaluators of that kind. */
export type PropertyAggregate =
  | { type: 'score'; n: number; mean: number; sd: number; min: number; max: number; values: number[] }
  | { type: 'boolean'; n: number; trueCount: number; falseCount: number; proportionTrue: number; majority: boolean | null; agreement: number }
  | { type: 'enum'; n: number; distribution: Record<string, number>; mode: string | null; agreement: number }
  | { type: 'enumSet'; n: number; distribution: Record<string, number>; selectionRate: Record<string, number>; consensus: string[] }
  | { type: 'text'; n: number; values: { source: string; value: string }[] }
  | { type: 'list'; n: number; values: { source: string; value: (string | number)[] }[] }

/** How the pooled LLM verdict differs from the pooled human verdict for one property. */
export type StreamComparison =
  | { kind: 'score'; llmMean: number; humanMean: number; delta: number }
  | { kind: 'boolean'; llm: boolean | null; human: boolean | null; agree: boolean | null }
  | { kind: 'enum'; llm: string | null; human: string | null; agree: boolean | null }
  | { kind: 'enumSet'; llm: string[]; human: string[]; jaccard: number }

export interface TicketAggregate {
  ticketId: number
  llm: Record<string, PropertyAggregate>
  human: Record<string, PropertyAggregate>
  comparison: Record<string, StreamComparison | null>
}

/** Dataset-level human-vs-LLM roll-up per property (over tickets where both streams have data). */
export type PropertyRollup =
  | { kind: 'score'; nTickets: number; meanAbsDelta: number; meanDelta: number }
  | { kind: 'agreement'; nTickets: number; agreementRate: number } // boolean/enum: majority match rate
  | { kind: 'enumSet'; nTickets: number; meanJaccard: number }
  | { kind: 'none' }

export interface AggregateResult {
  byTicket: Record<number, TicketAggregate>
  rollup: Record<string, PropertyRollup>
}

// --- Evaluation run (spec §6) ------------------------------------------------

/** Which tickets an LLM run targets. */
export type RunMode =
  | { kind: 'all' }
  | { kind: 'remaining' } // unevaluated, errored, or with unresolved dropped values
  | { kind: 'selection'; ticketIds: number[] }

/** Pre-run token/cost estimate (dollars only when the model's price is known — spec §5). */
export interface CostEstimate {
  provider: ProviderId
  model: string
  targetCount: number
  batches: number
  estimatedInputTokens: number
  estimatedOutputTokens: number
  estimatedTotalTokens: number
  /** USD, or null when the model's price isn't in the pricing map. */
  estimatedCostUsd: number | null
  priceKnown: boolean
  currency: 'USD'
  isLocal: boolean
}

/** Live progress streamed from main during a run. */
export interface EvaluationProgress {
  ticketsDone: number
  ticketsTotal: number
  batchesDone: number
  batchesTotal: number
  retries: number
  failed: number
  streamingTokens: number
  fraction: number
}

/** Final result of an LLM run — the updated working file + a stats summary. */
export interface EvalRunResult {
  workingFile: EvalFile
  cancelled: boolean
  stats: { evaluated: number; failed: number; retries: number }
}

// --- Settings (persisted, non-secret) ----------------------------------------

export interface OllamaConfig {
  host: string
  model: string
}

/** Anthropic config. Unlike Qbort, the user picks the model (fetched live). `null` until chosen. */
export interface AnthropicConfig {
  model: string | null
}

/** The full persisted settings document (no secrets — those live in the keychain). */
export interface Settings {
  providerId: ProviderId
  ollama: OllamaConfig
  anthropic: AnthropicConfig
  /** Display name stamped on the human evaluator (spec §2.4). */
  evaluatorName: string
  /** Working output schema; snapshotted into each eval file. */
  schema: EvalSchema
  /** Working free-form rules; snapshotted into each eval file. */
  rules: Rules
  /** Eval parallelism (concurrent batches). */
  concurrency: number
  /** Tickets per LLM call (adaptive at run time). */
  batchSize: number
  /** Folder where eval files are saved / opened. `null` → app default (userData). */
  defaultDir: string | null
  /** Path of the most recently written/loaded eval file. */
  lastWorkingPath: string | null
  /** Path of the tickets file backing the last working file (convenience pointer for silent
   *  re-open; not part of any eval file — the eval file references the dataset by fingerprint). */
  lastDatasetPath: string | null
}

// --- Secrets & connectivity --------------------------------------------------

/** Whether an API key is stored for each hosted provider. */
export type SecretStatus = Record<string, boolean>

/** Result of a provider "test connection" probe. */
export interface ConnectionTestResult {
  ok: boolean
  message: string
}

// --- IPC contract ------------------------------------------------------------

/**
 * The surface exposed on `window.api` by the preload script. Every method maps to a single,
 * explicitly allow-listed IPC channel handled in the main process. Keys are decrypted in main
 * only and never returned to the renderer (it learns only "is a key set").
 */
export interface IpcApi {
  app: {
    getVersion: () => Promise<string>
  }
  settings: {
    get: () => Promise<Settings>
    set: (partial: Partial<Settings>) => Promise<Settings>
  }
  secrets: {
    setKey: (provider: ProviderId, key: string) => Promise<boolean>
    hasKey: (provider: ProviderId) => Promise<boolean>
    clearKey: (provider: ProviderId) => Promise<boolean>
    status: () => Promise<SecretStatus>
  }
  provider: {
    testConnection: (provider: ProviderId) => Promise<ConnectionTestResult>
  }
  ollama: {
    listModels: (host: string) => Promise<string[]>
  }
  anthropic: {
    /** Fetch the account's available models from `/v1/models` (main reads the stored key). */
    listModels: () => Promise<string[]>
  }
  session: {
    /** Open dialog that auto-detects a Qbort tickets.json (→ fresh working file, discarding the
     *  current one) or a *.qval.json (→ load working file, relinking its dataset). This is also how
     *  you start over under new criteria: re-open the tickets.json. Returns null if cancelled. */
    open: () => Promise<SessionSnapshot | null>
    /** Silently reload the last working file + its dataset on launch, if both are available. */
    loadLast: () => Promise<SessionSnapshot | null>
    /** Write the working file (Save-As dialog if it has no path yet). Returns the path or null. */
    save: () => Promise<string | null>
    /** Pick a *.qval.json to MERGE as a comparison; throws with a reason on a fingerprint mismatch. */
    addComparison: () => Promise<SessionSnapshot | null>
    /** Remove a merged comparison by id; returns the updated session. */
    removeComparison: (id: string) => Promise<SessionSnapshot | null>
    /** Write a flat merged aggregate report to a chosen path. Returns the path or null. */
    exportReport: () => Promise<string | null>
  }
  evaluation: {
    estimate: (mode: RunMode) => Promise<CostEstimate>
    start: (mode: RunMode) => Promise<EvalRunResult>
    cancel: () => Promise<void>
    /** Subscribe to live progress; returns an unsubscribe function. */
    onProgress: (cb: (progress: EvaluationProgress) => void) => () => void
  }
  human: {
    /** Upsert this ticket's human values into the working file (main persists atomically). */
    setValues: (ticketId: number, values: EvalValues) => Promise<void>
  }
  dialog: {
    chooseDirectory: () => Promise<string | null>
  }
}

/** Channel name constants — keeps preload and main in sync without magic strings. */
export const IpcChannels = {
  appGetVersion: 'app:getVersion',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  secretsSetKey: 'secrets:setKey',
  secretsHasKey: 'secrets:hasKey',
  secretsClearKey: 'secrets:clearKey',
  secretsStatus: 'secrets:status',
  providerTestConnection: 'provider:testConnection',
  ollamaListModels: 'ollama:listModels',
  anthropicListModels: 'anthropic:listModels',
  sessionOpen: 'session:open',
  sessionLoadLast: 'session:loadLast',
  sessionSave: 'session:save',
  sessionAddComparison: 'session:addComparison',
  sessionRemoveComparison: 'session:removeComparison',
  sessionExportReport: 'session:exportReport',
  evaluationEstimate: 'evaluation:estimate',
  evaluationStart: 'evaluation:start',
  evaluationCancel: 'evaluation:cancel',
  evaluationProgress: 'evaluation:progress',
  humanSetValues: 'human:setValues',
  dialogChooseDirectory: 'dialog:chooseDirectory'
} as const
