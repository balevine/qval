/**
 * Shared types used by the renderer, the review server, and the evaluation engine.
 *
 * This file is the single source of truth for the host contract and the persisted data model.
 * `README.md` describes what the application does with them.
 */

// --- Eval schema (the user-defined output properties) ------------------------

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

// --- Tickets (the imported dataset, read-only) -------------------------------

export const TICKET_STATUSES = ['new', 'open', 'pending', 'on-hold', 'solved', 'closed'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

/** Author of a message. Whether they are staff is carried by `isStaff`, never inferred from here. */
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

/** A support ticket under evaluation. Qval reads this and never mutates the imported dataset. */
export interface Ticket {
  id: number
  subject: string
  status: TicketStatus
  messages: TicketMessage[]
}

// --- Eval file (`*.qval.json`) -----------------------------------------------

export type EvaluatorKind = 'llm' | 'human'

/** A single scored value. Array forms are for `multiple` properties. */
export type EvalValue = number | boolean | string | number[] | string[]

/** The per-ticket values map (partial: a missing key = "that property not scored"). */
export type EvalValues = Partial<Record<string, EvalValue>>

/** Non-silent repair trail: what validation coerced or dropped for a value. */
export interface EvalIssue {
  key: string
  action: 'clamped' | 'coerced' | 'dropped'
  /** The pre-repair value (advisory; may be absent on older/loaded files). */
  original?: unknown
}

/** One evaluator's scores for one ticket. `results` is sparse, so only scored tickets appear. */
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
  /** Drives stream separation & aggregation. Never inferred from `name`. */
  kind: EvaluatorKind
  /** Display label (the human name comes from the run config). */
  name: string
  /** What produced an `llm` evaluator. `'claude-code'` for anything Qval writes now; a file from
   *  an older release may carry `'ollama'`/`'anthropic'`, which still reads and merges. */
  provider?: string
  model?: string
  results: EvalResult[]
}

/** The dataset an eval file references (by fingerprint, since tickets are not embedded). */
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
  /** Stable id. Opaque to the UI: the host maps it back to a file. */
  id: string
  /** Display label (filename). */
  name: string
  evaluators: Evaluator[]
}

/**
 * A file the host found and is willing to merge, offered to the UI by name only. The path stays
 * host-side, which is what lets MERGE work in a browser without any endpoint accepting one.
 */
export interface ComparisonCandidate {
  id: string
  name: string
  /** Whether it is currently merged into the session. */
  merged: boolean
}

/** The in-memory working session: the loaded dataset + the editable working file + merged files. */
export interface SessionSnapshot {
  tickets: Ticket[]
  workingFile: EvalFile
  /** Path the working file was opened from / last saved to; null when unsaved. */
  workingPath: string | null
  /** Read-only files added via MERGE, pooled into the aggregates/comparison. */
  comparisons: ComparisonFile[]
  /** Mergeable files the host located, merged or not. Empty when the host offers none. */
  candidates: ComparisonCandidate[]
}

// --- Aggregates & comparison (derived at merge time) -------------------------

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

// --- Settings (persisted) ----------------------------------------------------

/**
 * The full persisted settings document. There are no secrets in it and no provider config either:
 * the LLM evaluation runs inside Claude Code with the ambient model, so there is no
 * key to store and no model to pick here.
 */
export interface Settings {
  /** Display name stamped on the human evaluator. */
  evaluatorName: string
  /** Working output schema; snapshotted into each eval file. */
  schema: EvalSchema
  /** Working free-form rules; snapshotted into each eval file. */
  rules: Rules
  /** Path of the tickets file backing the working file. It is how an eval file relinks its dataset
   *  without being handed one, and it is not part of any eval file (which references the dataset by
   *  fingerprint). There is no `defaultDir` and no last-file pointer: the host binds every path from
   *  argv before the browser exists, so there is nothing for settings to remember. */
  lastDatasetPath: string | null
}

// --- IPC contract ------------------------------------------------------------

/**
 * The one surface the UI reaches its host through, named for the IPC bridge it started as.
 * `renderer/lib/apiClient.ts` implements it over `fetch` against the review server, which is the
 * only host there is now that the Electron shell is gone.
 *
 * **Nothing here takes or returns a path the UI chose.** The host resolves every file before the
 * browser exists, so opening, merging, and exporting are all named by id or by nothing at all.
 * That is why there is no `open` and no directory picker.
 */
export interface IpcApi {
  settings: {
    get: () => Promise<Settings>
    set: (partial: Partial<Settings>) => Promise<Settings>
  }
  session: {
    /**
     * Everything the UI needs to start: the host's version, and the session it bound at launch
     * (null when it bound nothing). One call, because the host answers all of it in one response.
     * There is no separate version getter: a second round trip for a field this one already
     * carries is how the old one worked, and nothing rendered the result.
     */
    boot: () => Promise<{ appVersion: string; session: SessionSnapshot | null }>
    /** MERGE a candidate by id; throws with a reason on a fingerprint mismatch. */
    mergeComparison: (id: string) => Promise<SessionSnapshot | null>
    /** Un-merge a comparison by id; returns the updated session. */
    unmergeComparison: (id: string) => Promise<SessionSnapshot | null>
    /** Write the flat merged aggregate report beside the working file. Returns its path. */
    exportReport: () => Promise<string | null>
  }
  human: {
    /** Upsert this ticket's human values into the working file (the host persists atomically). */
    setValues: (ticketId: number, values: EvalValues) => Promise<void>
  }
  review: {
    /** End the review session: the host stops serving and records the run as finished. */
    done: () => Promise<void>
  }
}
