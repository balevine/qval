// Pure aggregation. LLM and human evaluators are pooled into two **separate**
// groups by `kind` and never combined. The headline output is the per-property `comparison`
// (LLM group vs human group) plus a dataset-level roll-up.

/**
 * @typedef {import('@shared/types').AggregateResult} AggregateResult
 * @typedef {import('@shared/types').ComparisonFile} ComparisonFile
 * @typedef {import('@shared/types').EvalFile} EvalFile
 * @typedef {import('@shared/types').EvalProperty} EvalProperty
 * @typedef {import('@shared/types').EvalResult} EvalResult
 * @typedef {import('@shared/types').EvalSchema} EvalSchema
 * @typedef {import('@shared/types').EvalValue} EvalValue
 * @typedef {import('@shared/types').EvaluatorKind} EvaluatorKind
 * @typedef {import('@shared/types').PropertyAggregate} PropertyAggregate
 * @typedef {import('@shared/types').PropertyRollup} PropertyRollup
 * @typedef {import('@shared/types').StreamComparison} StreamComparison
 *
 * One evaluator's results, flattened for lookup by ticket.
 * @typedef {object} Stream
 * @property {EvaluatorKind} kind
 * @property {string} name
 * @property {string} source
 * @property {Map<number, EvalResult>} byTicket
 *
 * One collected value plus the column label it came from.
 * @typedef {{ value: EvalValue, label: string }} Entry
 */

// --- small stats -------------------------------------------------------------

function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
}

/** Sample standard deviation (n−1). 0 when n<2. */
function sampleSd(nums) {
  if (nums.length < 2) return 0
  const m = mean(nums)
  const variance = nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1)
  return Math.sqrt(variance)
}

/**
 * Overlap of two option sets (both empty → 1, "they agree on nothing selected").
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function jaccard(a, b) {
  const A = new Set(a)
  const B = new Set(b)
  const union = new Set([...a, ...b])
  if (union.size === 0) return 1
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / union.size
}

// --- streams -----------------------------------------------------------------

/**
 * Flatten the working file's evaluators (source "(this file)") plus every comparison file's into a
 * list of streams, de-duplicating on `(kind, name, sourceId)` so the same file added twice
 * collapses. `sourceId` is the comparison's **unique id** (its file path), not its display name.
 * Keying on the name would silently drop an evaluator when two merged files share a basename.
 * @param {EvalFile} workingFile
 * @param {ComparisonFile[]} comparisons
 * @returns {Stream[]}
 */
export function buildStreams(workingFile, comparisons) {
  /** @type {Stream[]} */
  const streams = []
  const seen = new Set()
  const add = (evaluators, sourceId, label) => {
    for (const e of evaluators) {
      const key = `${e.kind}::${e.name}::${sourceId}`
      if (seen.has(key)) continue
      seen.add(key)
      streams.push({
        kind: e.kind,
        name: e.name,
        source: label,
        byTicket: new Map(e.results.map((r) => [r.ticketId, r]))
      })
    }
  }
  add(workingFile.evaluators, '(this file)', '(this file)')
  for (const c of comparisons) add(c.evaluators, c.id, c.name)
  return streams
}

/**
 * The label used as a text/list value's `source` and the side-by-side column header.
 * @param {string} name
 * @param {string} source
 * @returns {string}
 */
export function streamLabel(name, source) {
  return source === '(this file)' ? `${name} (this file)` : name
}

// --- per-property aggregation ------------------------------------------------

/**
 * @param {EvalProperty} p
 * @returns {'score' | 'boolean' | 'enum' | 'enumSet' | 'text' | 'list'}
 */
function aggKind(p) {
  if (p.type === 'score') return p.multiple ? 'list' : 'score'
  if (p.type === 'enum') return p.multiple ? 'enumSet' : 'enum'
  return p.type // 'boolean' | 'text'
}

/**
 * @param {EvalProperty} p
 * @param {number} ticketId
 * @param {Stream[]} streams
 * @returns {Entry[]}
 */
function collect(p, ticketId, streams) {
  /** @type {Entry[]} */
  const out = []
  for (const s of streams) {
    const v = s.byTicket.get(ticketId)?.values[p.key]
    if (v === undefined) continue
    out.push({ value: v, label: streamLabel(s.name, s.source) })
  }
  return out
}

/**
 * Aggregate the collected values for one property + ticket + stream, or null if none.
 * @param {EvalProperty} p
 * @param {Entry[]} entries
 * @returns {PropertyAggregate | null}
 */
export function aggregateProperty(p, entries) {
  if (entries.length === 0) return null
  const n = entries.length
  const kind = aggKind(p)

  if (kind === 'score') {
    const nums = entries.map((e) => Number(e.value)).filter((x) => Number.isFinite(x))
    return {
      type: 'score',
      n: nums.length,
      mean: mean(nums),
      sd: sampleSd(nums),
      min: Math.min(...nums),
      max: Math.max(...nums),
      values: nums
    }
  }
  if (kind === 'boolean') {
    const trueCount = entries.filter((e) => e.value === true).length
    const falseCount = entries.filter((e) => e.value === false).length
    const majority = trueCount > falseCount ? true : falseCount > trueCount ? false : null
    return {
      type: 'boolean',
      n,
      trueCount,
      falseCount,
      proportionTrue: trueCount / n,
      majority,
      agreement: Math.max(trueCount, falseCount) / n
    }
  }
  if (kind === 'enum') {
    const distribution = {}
    for (const e of entries) distribution[String(e.value)] = (distribution[String(e.value)] ?? 0) + 1
    const { mode, count } = modeOf(distribution)
    return { type: 'enum', n, distribution, mode, agreement: count / n }
  }
  if (kind === 'enumSet') {
    const distribution = {}
    for (const e of entries) for (const opt of new Set(e.value)) distribution[opt] = (distribution[opt] ?? 0) + 1
    const selectionRate = {}
    const consensus = []
    for (const [opt, c] of Object.entries(distribution)) {
      selectionRate[opt] = c / n
      if (c / n > 0.5) consensus.push(opt)
    }
    return { type: 'enumSet', n, distribution, selectionRate, consensus: consensus.sort() }
  }
  if (kind === 'list') {
    return { type: 'list', n, values: entries.map((e) => ({ source: e.label, value: e.value })) }
  }
  return { type: 'text', n, values: entries.map((e) => ({ source: e.label, value: String(e.value) })) }
}

/**
 * The single most common key (null on a tie), and its count.
 * @param {Record<string, number>} distribution
 * @returns {{ mode: string | null, count: number }}
 */
function modeOf(distribution) {
  /** @type {string | null} */
  let mode = null
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

/**
 * Compare the pooled LLM aggregate to the pooled human aggregate for one property.
 * @param {PropertyAggregate} llm
 * @param {PropertyAggregate} human
 * @returns {StreamComparison | null}
 */
export function compareStreams(llm, human) {
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
  return null // text / list, so no scalar comparison
}

// --- top-level ---------------------------------------------------------------

/**
 * @param {number[]} ticketIds
 * @param {EvalSchema} schema
 * @param {Stream[]} streams
 * @returns {AggregateResult}
 */
export function computeAggregates(ticketIds, schema, streams) {
  const llmStreams = streams.filter((s) => s.kind === 'llm')
  const humanStreams = streams.filter((s) => s.kind === 'human')
  /** @type {AggregateResult['byTicket']} */
  const byTicket = {}
  const acc = {}
  for (const p of schema) {
    acc[p.key] = { score: { absDelta: 0, delta: 0, n: 0 }, agree: { agreeCount: 0, n: 0 }, jaccard: { sum: 0, n: 0 } }
  }

  for (const id of ticketIds) {
    /** @type {Record<string, PropertyAggregate>} */
    const llm = {}
    /** @type {Record<string, PropertyAggregate>} */
    const human = {}
    /** @type {Record<string, StreamComparison | null>} */
    const comparison = {}
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

  /** @type {Record<string, PropertyRollup>} */
  const rollup = {}
  for (const p of schema) rollup[p.key] = finalize(aggKind(p), acc[p.key])
  return { byTicket, rollup }
}

function accumulate(a, cmp) {
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

/** @returns {PropertyRollup} */
function finalize(kind, a) {
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

/**
 * Convenience: build streams + aggregate over the given ticket ids.
 * @param {EvalFile} workingFile
 * @param {ComparisonFile[]} comparisons
 * @param {number[]} ticketIds
 * @returns {AggregateResult}
 */
export function aggregateSession(workingFile, comparisons, ticketIds) {
  return computeAggregates(ticketIds, workingFile.meta.config.schema, buildStreams(workingFile, comparisons))
}
