import type { EvalProperty } from '@shared/types'

/** Compact integer formatting, e.g. 1400400 → "1,400,400". */
export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** Best-effort human message from an unknown thrown value, with an optional fallback. */
export function errorMessage(e: unknown, fallback?: string): string {
  if (e instanceof Error) return e.message
  return fallback ?? String(e)
}

/** ISO 8601 → a compact local date+time, e.g. "Jun 30, 2026, 12:00 PM". Falls back to the raw string. */
export function formatTimestamp(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return new Date(t).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** Human-readable rendering of an eval value (for the LLM reference + compact displays). */
export function formatEvalValue(v: unknown): string {
  if (v === undefined || v === null) return '—'
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(none)'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

/**
 * The level label a stored score means, for a property scored on named levels (a Jev score). The
 * value is the level's index, so anything that is not a whole index into `levels` has no label.
 */
export function levelLabel(p: EvalProperty, v: unknown): string | null {
  if (!p.levels || typeof v !== 'number' || !Number.isInteger(v)) return null
  return p.levels[v]?.label ?? null
}

/** `formatEvalValue`, plus the level label beside the stored index when the property has levels. */
export function formatPropertyValue(v: unknown, p: EvalProperty): string {
  const label = levelLabel(p, v)
  return label === null ? formatEvalValue(v) : `${v} · ${label}`
}

/**
 * The definition of one possible answer to a property, where the schema carries one: a level's
 * description, what a yes or a no means, or an enum option's definition. Only a Jev schema has
 * these, so under Claude this is always null.
 */
export function answerHint(p: EvalProperty, v: unknown): string | null {
  if (p.type === 'score' && p.levels && typeof v === 'number') return p.levels[v]?.description ?? null
  if (p.type === 'boolean' && v === true) return p.trueDescription ?? null
  if (p.type === 'boolean' && v === false) return p.falseDescription ?? null
  if (p.type === 'enum' && typeof v === 'string') return p.optionDescriptions?.[v] ?? null
  return null
}
