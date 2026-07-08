import type { PropertyAggregate, PropertyRollup, StreamComparison } from '@shared/types'

/** One stream's headline value, compact. */
function short(agg: PropertyAggregate): string {
  switch (agg.type) {
    case 'score':
      return agg.mean.toFixed(1)
    case 'boolean':
      return agg.majority === true ? 'YES' : agg.majority === false ? 'NO' : 'TIE'
    case 'enum':
      return agg.mode ?? 'TIE'
    case 'enumSet':
      return agg.consensus.length ? agg.consensus.join('+') : '∅'
    case 'text':
    case 'list':
      return `${agg.n}×`
  }
}

/** A single-stream cell (LLM or Human focus mode) with its spread/agreement. */
export function formatStreamCell(agg: PropertyAggregate | undefined): string {
  if (!agg) return '—'
  switch (agg.type) {
    case 'score':
      return agg.n > 1 ? `${agg.mean.toFixed(1)}±${agg.sd.toFixed(1)} (${agg.n})` : agg.mean.toFixed(1)
    case 'boolean':
      return `${short(agg)} ${Math.round(agg.agreement * 100)}%${agg.n > 1 ? ` (${agg.n})` : ''}`
    case 'enum':
      return `${short(agg)} ${Math.round(agg.agreement * 100)}%${agg.n > 1 ? ` (${agg.n})` : ''}`
    case 'enumSet': {
      const top = Object.entries(agg.distribution)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([o, c]) => `${o} ${c}/${agg.n}`)
      return top.join(' · ') || '∅'
    }
    case 'text':
      return `${agg.n} note${agg.n === 1 ? '' : 's'}`
    case 'list':
      return `${agg.n}×`
  }
}

/** A comparison cell (default mode): both streams' headline + how they differ. */
export function formatComparisonCell(
  llm: PropertyAggregate | undefined,
  human: PropertyAggregate | undefined,
  cmp: StreamComparison | null
): { text: string; disagree: boolean } {
  const l = llm ? short(llm) : '—'
  const h = human ? short(human) : '—'
  let extra = ''
  let disagree = false
  if (cmp) {
    if (cmp.kind === 'score') {
      const d = cmp.delta
      if (Math.abs(d) >= 0.05) extra = ` Δ${d >= 0 ? '+' : ''}${d.toFixed(1)}`
      disagree = Math.abs(d) >= 1
    } else if (cmp.kind === 'enumSet') {
      extra = ` J${cmp.jaccard.toFixed(2)}`
      disagree = cmp.jaccard < 0.5
    } else if (cmp.agree !== null) {
      extra = cmp.agree ? ' ✓' : ' ✗'
      disagree = !cmp.agree
    }
  }
  return { text: `L ${l} / H ${h}${extra}`, disagree }
}

/** The dataset-level roll-up for a property. */
export function formatRollup(r: PropertyRollup): string {
  switch (r.kind) {
    case 'score':
      return `Δ ${r.meanDelta >= 0 ? '+' : ''}${r.meanDelta.toFixed(2)} · |Δ| ${r.meanAbsDelta.toFixed(2)} (n${r.nTickets})`
    case 'agreement':
      return `${Math.round(r.agreementRate * 100)}% agree (n${r.nTickets})`
    case 'enumSet':
      return `J ${r.meanJaccard.toFixed(2)} (n${r.nTickets})`
    case 'none':
      return '—'
  }
}
