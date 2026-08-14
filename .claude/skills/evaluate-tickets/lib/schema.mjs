// Port of src/shared/schema.ts (types stripped). Kept byte-identical in behavior because
// `normalizeSchema` feeds the config fingerprint, so any drift here silently breaks merge between
// CLI-produced and app-produced eval files. Guarded by test/skillParity.test.ts.

/** Base types that may be made multi-valued (`multiple: true`). Boolean and text are single-value. */
export const MULTIPLE_ALLOWED = ['score', 'enum']

const PROPERTY_TYPES = ['score', 'boolean', 'enum', 'text']

/** Default output schema: a small starting point (a boolean + a multi-select enum) the user edits. */
export const DEFAULT_SCHEMA = [
  { key: 'resolved', label: 'Resolved', type: 'boolean',
    description: 'Was the customer’s issue actually resolved (not just deflected)?' },
  { key: 'categories', label: 'Categories', type: 'enum', multiple: true,
    options: ['bug', 'billing', 'how-to', 'feature-request'],
    description: 'All categories that apply to this ticket (zero or more).' }
]

/** Default step for score properties when unset. */
export const DEFAULT_SCORE = { min: 1, max: 5, step: 1 }

/** True when a base type may be made multi-valued. */
export function allowsMultiple(type) {
  return MULTIPLE_ALLOWED.includes(type)
}

/** Derive a stable camelCase key from a human label (e.g. "Follow Up" → "followUp"). */
export function toCamelKey(raw) {
  const parts = raw.trim().toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean)
  if (parts.length === 0) return ''
  return parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('')
}

/**
 * Validation for one property, given the keys of the *other* rows (for uniqueness). Returns a list
 * of human-readable problems; an empty list means the row is valid. `config --check` prints these
 * per row; `normalizeSchema` is the stricter at-rest/at-use pass.
 */
export function propertyErrors(prop, otherKeys) {
  const errors = []
  if (!String(prop.label ?? '').trim()) errors.push('Label is required.')
  const key = String(prop.key ?? '').trim()
  if (!key) errors.push('Key is required.')
  else if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) errors.push('Key must be camelCase (letters/digits, starting with a letter).')
  else if (otherKeys.includes(key)) errors.push(`Key "${key}" is already used.`)

  if (prop.multiple && !allowsMultiple(prop.type)) errors.push('This type cannot be multi-valued.')

  if (prop.type === 'score') {
    const { min, max, step } = prop
    if (typeof min !== 'number' || typeof max !== 'number' || min >= max) errors.push('Score needs min < max.')
    if (typeof step !== 'number' || step <= 0) errors.push('Step must be greater than 0.')
  }
  if (prop.type === 'enum') {
    const opts = (prop.options ?? []).map((o) => o.trim()).filter(Boolean)
    if (opts.length < 2) errors.push('Enum needs at least 2 non-empty options.')
    if (new Set(opts).size !== opts.length) errors.push('Enum options must be unique.')
  }
  return errors
}

/**
 * Coerce one raw property into a well-formed property, or return null if it can't be made valid
 * (missing key/label, bad type, enum without options).
 */
function normalizeProperty(raw) {
  if (!raw || typeof raw !== 'object') return null
  const r = raw
  const type = PROPERTY_TYPES.includes(r.type) ? r.type : null
  if (!type) return null
  const label = typeof r.label === 'string' ? r.label.trim() : ''
  const key = typeof r.key === 'string' && r.key.trim() ? r.key.trim() : toCamelKey(label)
  if (!key || !label) return null

  const prop = { key, label, type }
  if (typeof r.description === 'string' && r.description.trim()) prop.description = r.description
  if (r.multiple === true && allowsMultiple(type)) prop.multiple = true

  if (type === 'score') {
    const min = typeof r.min === 'number' && Number.isFinite(r.min) ? r.min : DEFAULT_SCORE.min
    const max = typeof r.max === 'number' && Number.isFinite(r.max) ? r.max : DEFAULT_SCORE.max
    prop.min = Math.min(min, max)
    prop.max = Math.max(min, max)
    prop.step = typeof r.step === 'number' && r.step > 0 ? r.step : DEFAULT_SCORE.step
  }
  if (type === 'enum') {
    const options = Array.isArray(r.options)
      ? Array.from(new Set(r.options.filter((o) => typeof o === 'string' && !!o.trim()).map((o) => o.trim())))
      : []
    if (options.length < 2) return null // an enum needs ≥2 options to be meaningful
    prop.options = options
  }
  return prop
}

/**
 * Normalize a raw schema: drop invalid properties and de-duplicate keys. Falls back to the default
 * schema when the result is empty (so there is never no way to evaluate).
 */
export function normalizeSchema(raw) {
  if (!Array.isArray(raw)) return DEFAULT_SCHEMA.map((p) => ({ ...p }))
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const prop = normalizeProperty(item)
    if (!prop || seen.has(prop.key)) continue
    seen.add(prop.key)
    out.push(prop)
  }
  return out.length > 0 ? out : DEFAULT_SCHEMA.map((p) => ({ ...p }))
}
