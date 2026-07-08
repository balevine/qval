import type {
  AggregateResult,
  ComparisonFile,
  EvalFile,
  EvalProperty,
  EvalResult,
  EvalSchema,
  EvalValue,
  Evaluator,
  EvaluatorKind,
  PropertyAggregate,
  PropertyRollup,
  StreamComparison,
  TicketAggregate
} from './types'

/**
 * Pure aggregation (spec §2.6/§8). LLM and human evaluators are pooled into two **separate**
 * groups by `kind` and never combined; the headline output is the per-property `comparison`
 * (LLM group vs human group) plus a dataset-level roll-up. Exhaustively testable.
 */

// --- small stats -------------------------------------------------------------

function mean(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
}
/** Sample standard deviation (n−1); 0 when n<2. */
function sampleSd(nums: number[]): number {
  if (nums.length < 2) return 0
  const m = mean(nums)
  const variance = nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1)
  return Math.sqrt(variance)
}
/** Overlap of two option sets (both empty → 1, "they agree on nothing selected"). */
export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a)
  const B = new Set(b)
  const union = new Set([...a, ...b])
  if (union.size === 0) return 1
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / union.size
}

// --- streams -----------------------------------------------------------------

interface Stream {
  kind: EvaluatorKind
  name: string
  source: string
  byTicket: Map<number, EvalResult>
}

/**
 * Flatten the working file's evaluators (source "(this file)") plus every comparison file's into a
 * list of streams, de-duplicating on `(kind, name, sourceId)` so the same file added twice
 * collapses. `sourceId` is the comparison's **unique id** (its file path), not its display name —
 * keying on the name would silently drop an evaluator when two merged files share a basename.
 */
export function buildStreams(workingFile: EvalFile, comparisons: ComparisonFile[]): Stream[] {
  const streams: Stream[] = []
  const seen = new Set<string>()
  const add = (evaluators: Evaluator[], sourceId: string, label: string) => {
    for (const e of evaluators) {
      const key = `${e.kind}::${e.name}::${sourceId}`
      if (seen.has(key)) continue
      seen.add(key)
      streams.push({ kind: e.kind, name: e.name, source: label, byTicket: new Map(e.results.map((r) => [r.ticketId, r])) })
    }
  }
  add(workingFile.evaluators, '(this file)', '(this file)')
  for (const c of comparisons) add(c.evaluators, c.id, c.name)
  return streams
}

/** The label used as a text/list value's `source` and the side-by-side column header. */
export function streamLabel(name: string, source: string): string {
  return source === '(this file)' ? `${name} (this file)` : name
}

// --- per-property aggregation ------------------------------------------------

type AggKind = 'score' | 'boolean' | 'enum' | 'enumSet' | 'text' | 'list'
function aggKind(p: EvalProperty): AggKind {
  if (p.type === 'score') return p.multiple ? 'list' : 'score'
  if (p.type === 'enum') return p.multiple ? 'enumSet' : 'enum'
  return p.type // 'boolean' | 'text'
}

interface Entry {
  value: EvalValue
  label: string
}

function collect(p: EvalProperty, ticketId: number, streams: Stream[]): Entry[] {
  const out: Entry[] = []
  for (const s of streams) {
    const v = s.byTicket.get(ticketId)?.values[p.key]
    if (v === undefined) continue
    out.push({ value: v, label: streamLabel(s.name, s.source) })
  }
  return out
}

/** Aggregate the collected values for one property + ticket + stream, or null if none. */
export function aggregateProperty(p: EvalProperty, entries: Entry[]): PropertyAggregate | null {
  if (entries.length === 0) return null
  const n = entries.length
  const kind = aggKind(p)

  if (kind === 'score') {
    const nums = entries.map((e) => Number(e.value)).filter((x) => Number.isFinite(x))
    return { type: 'score', n: nums.length, mean: mean(nums), sd: sampleSd(nums), min: Math.min(...nums), max: Math.max(...nums), values: nums }
  }
  if (kind === 'boolean') {
    const trueCount = entries.filter((e) => e.value === true).length
    const falseCount = entries.filter((e) => e.value === false).length
    const majority = trueCount > falseCount ? true : falseCount > trueCount ? false : null
    return { type: 'boolean', n, trueCount, falseCount, proportionTrue: trueCount / n, majority, agreement: Math.max(trueCount, falseCount) / n }
  }
  if (kind === 'enum') {
    const distribution: Record<string, number> = {}
    for (const e of entries) distribution[String(e.value)] = (distribution[String(e.value)] ?? 0) + 1
    const { mode, count } = modeOf(distribution)
    return { type: 'enum', n, distribution, mode, agreement: count / n }
  }
  if (kind === 'enumSet') {
    const distribution: Record<string, number> = {}
    for (const e of entries) for (const opt of new Set(e.value as string[])) distribution[opt] = (distribution[opt] ?? 0) + 1
    const selectionRate: Record<string, number> = {}
    const consensus: string[] = []
    for (const [opt, c] of Object.entries(distribution)) {
      selectionRate[opt] = c / n
      if (c / n > 0.5) consensus.push(opt)
    }
    return { type: 'enumSet', n, distribution, selectionRate, consensus: consensus.sort() }
  }
  if (kind === 'list') {
    return { type: 'list', n, values: entries.map((e) => ({ source: e.label, value: e.value as (string | number)[] })) }
  }
  return { type: 'text', n, values: entries.map((e) => ({ source: e.label, value: String(e.value) })) }
}

/** The single most common key (null on a tie), and its count. */
function modeOf(distribution: Record<string, number>): { mode: string | null; count: number } {
  let mode: string | null = null
  let count = 0
  let tied = false
  for (const [k, c] of Object.entries(distribution)) {
    if (c > count) {
      count = c
      mode = k
      tied = false
    } else if (c === count) {
      tied = true
    }
  }
  return { mode: tied ? null : mode, count }
}

// --- comparison --------------------------------------------------------------

/** Compare the pooled LLM aggregate to the pooled human aggregate for one property (§2.6). */
export function compareStreams(llm: PropertyAggregate, human: PropertyAggregate): StreamComparison | null {
  if (llm.type === 'score' && human.type === 'score') {
    return { kind: 'score', llmMean: llm.mean, humanMean: human.mean, delta: human.mean - llm.mean }
  }
  if (llm.type === 'boolean' && human.type === 'boolean') {
    const agree = llm.majority !== null && human.majority !== null ? llm.majority === human.majority : null
    return { kind: 'boolean', llm: llm.majority, human: human.majority, agree }
  }
  if (llm.type === 'enum' && human.type === 'enum') {
    const agree = llm.mode !== null && human.mode !== null ? llm.mode === human.mode : null
    return { kind: 'enum', llm: llm.mode, human: human.mode, agree }
  }
  if (llm.type === 'enumSet' && human.type === 'enumSet') {
    return { kind: 'enumSet', llm: llm.consensus, human: human.consensus, jaccard: jaccard(llm.consensus, human.consensus) }
  }
  return null // text / list — no scalar comparison
}

// --- top-level ---------------------------------------------------------------

interface RollAcc {
  score: { absDelta: number; delta: number; n: number }
  agree: { agreeCount: number; n: number }
  jaccard: { sum: number; n: number }
}

export function computeAggregates(ticketIds: number[], schema: EvalSchema, streams: Stream[]): AggregateResult {
  const llmStreams = streams.filter((s) => s.kind === 'llm')
  const humanStreams = streams.filter((s) => s.kind === 'human')
  const byTicket: Record<number, TicketAggregate> = {}
  const acc: Record<string, RollAcc> = {}
  for (const p of schema) acc[p.key] = { score: { absDelta: 0, delta: 0, n: 0 }, agree: { agreeCount: 0, n: 0 }, jaccard: { sum: 0, n: 0 } }

  for (const id of ticketIds) {
    const llm: Record<string, PropertyAggregate> = {}
    const human: Record<string, PropertyAggregate> = {}
    const comparison: Record<string, StreamComparison | null> = {}
    for (const p of schema) {
      const lAgg = aggregateProperty(p, collect(p, id, llmStreams))
      const hAgg = aggregateProperty(p, collect(p, id, humanStreams))
      if (lAgg) llm[p.key] = lAgg
      if (hAgg) human[p.key] = hAgg
      const cmp = lAgg && hAgg ? compareStreams(lAgg, hAgg) : null
      comparison[p.key] = cmp
      if (cmp) accumulate(acc[p.key], cmp)
    }
    byTicket[id] = { ticketId: id, llm, human, comparison }
  }

  const rollup: Record<string, PropertyRollup> = {}
  for (const p of schema) rollup[p.key] = finalize(aggKind(p), acc[p.key])
  return { byTicket, rollup }
}

function accumulate(a: RollAcc, cmp: StreamComparison): void {
  if (cmp.kind === 'score') {
    a.score.delta += cmp.delta
    a.score.absDelta += Math.abs(cmp.delta)
    a.score.n++
  } else if (cmp.kind === 'boolean' || cmp.kind === 'enum') {
    if (cmp.agree !== null) {
      a.agree.n++
      if (cmp.agree) a.agree.agreeCount++
    }
  } else {
    a.jaccard.sum += cmp.jaccard
    a.jaccard.n++
  }
}

function finalize(kind: AggKind, a: RollAcc): PropertyRollup {
  if (kind === 'score') {
    return a.score.n > 0
      ? { kind: 'score', nTickets: a.score.n, meanAbsDelta: a.score.absDelta / a.score.n, meanDelta: a.score.delta / a.score.n }
      : { kind: 'none' }
  }
  if (kind === 'boolean' || kind === 'enum') {
    return a.agree.n > 0 ? { kind: 'agreement', nTickets: a.agree.n, agreementRate: a.agree.agreeCount / a.agree.n } : { kind: 'none' }
  }
  if (kind === 'enumSet') {
    return a.jaccard.n > 0 ? { kind: 'enumSet', nTickets: a.jaccard.n, meanJaccard: a.jaccard.sum / a.jaccard.n } : { kind: 'none' }
  }
  return { kind: 'none' }
}

/** Convenience: build streams + aggregate over the given ticket ids. */
export function aggregateSession(
  workingFile: EvalFile,
  comparisons: ComparisonFile[],
  ticketIds: number[]
): AggregateResult {
  return computeAggregates(ticketIds, workingFile.meta.config.schema, buildStreams(workingFile, comparisons))
}
