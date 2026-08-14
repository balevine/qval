// Port of src/shared/evalValidate.ts. Per-value coerce-or-drop: every property is validated
// independently, so one bad field never discards a ticket's other values, and every repair is
// recorded in `issues` (non-silent). Identical rules to the app so both produce the same values
// from the same model output.

/**
 * Clamp a score into its `[min,max]` range and snap it to `step`.
 */
export function clampScore(n, p) {
  const min = p.min ?? 1
  const max = p.max ?? 5
  const step = p.step && p.step > 0 ? p.step : 1
  const clamped = Math.min(max, Math.max(min, n))
  const snapped = Math.round((clamped - min) / step) * step + min
  return Math.min(max, Math.max(min, Number(snapped.toFixed(6))))
}

function coerceScore(raw, p) {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return { ok: false }
  return { ok: true, value: clampScore(n, p) }
}

function coerceBoolean(raw) {
  if (typeof raw === 'boolean') return { ok: true, value: raw }
  if (typeof raw === 'number') return { ok: true, value: raw !== 0 }
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase()
    if (['true', 'yes', 'y', '1'].includes(s)) return { ok: true, value: true }
    if (['false', 'no', 'n', '0'].includes(s)) return { ok: true, value: false }
  }
  return { ok: false }
}

function coerceEnum(raw, p) {
  if (typeof raw !== 'string') return { ok: false }
  const options = p.options ?? []
  if (options.includes(raw)) return { ok: true, value: raw }
  const norm = raw.trim().toLowerCase()
  const near = options.find((o) => o.trim().toLowerCase() === norm)
  return near ? { ok: true, value: near } : { ok: false }
}

function coerceText(raw) {
  if (typeof raw === 'string') return { ok: true, value: raw }
  if (typeof raw === 'number' || typeof raw === 'boolean') return { ok: true, value: String(raw) }
  return { ok: false }
}

/** Coerce a single (non-array) value for a property. */
function coerceScalar(raw, p) {
  switch (p.type) {
    case 'score':
      return coerceScore(raw, p)
    case 'boolean':
      return coerceBoolean(raw)
    case 'enum':
      return coerceEnum(raw, p)
    case 'text':
      return coerceText(raw)
    default:
      return { ok: false }
  }
}

/** Whether a coercion changed the value's form (→ 'coerced' vs 'clamped' vs exact). */
function actionFor(p, original, value) {
  if (p.type === 'score' && typeof original === 'number' && original !== value) return 'clamped'
  return 'coerced'
}

/**
 * Validate/repair one property's raw value. Returns the accepted value (possibly `[]`) or marks it
 * dropped. `multiple` properties become arrays: each element is coerced, invalid elements dropped,
 * and the result de-duplicated; `[]` ("none apply") is a valid, scored value.
 */
function validateProperty(raw, p) {
  if (p.multiple) {
    const arr = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
    const out = []
    let droppedAny = false
    for (const el of arr) {
      const c = coerceScalar(el, p)
      if (c.ok) out.push(c.value)
      else droppedAny = true
    }
    const deduped = Array.from(new Set(out))
    const issue = droppedAny ? { key: p.key, action: 'coerced', original: raw } : undefined
    return { value: deduped, issue }
  }

  const c = coerceScalar(raw, p)
  if (!c.ok) return { issue: { key: p.key, action: 'dropped', original: raw } }
  const changed = JSON.stringify(c.value) !== JSON.stringify(raw)
  const issue = changed ? { key: p.key, action: actionFor(p, raw, c.value), original: raw } : undefined
  return { value: c.value, issue }
}

/**
 * Validate a raw values object (from the model) against the schema. Keys not in the schema are
 * ignored; a property the model omitted is simply left unscored (no issue). Dropped values are
 * absent from `values` and recorded in `issues`.
 */
export function validateValues(raw, schema) {
  const obj = raw && typeof raw === 'object' ? raw : {}
  const values = {}
  const issues = []
  for (const p of schema) {
    if (!(p.key in obj)) continue // not scored, so no issue
    const { value, issue } = validateProperty(obj[p.key], p)
    if (value !== undefined) values[p.key] = value
    if (issue) issues.push(issue)
  }
  return { values, issues }
}

/** True if a result has any dropped value (→ eligible for the single validation retry). */
export function hasDrops(issues) {
  return !!issues?.some((i) => i.action === 'dropped')
}
