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
