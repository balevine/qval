import { MULTIPLE_ALLOWED, type EvalProperty, type EvalSchema, type PropertyType } from './types'

const PROPERTY_TYPES: PropertyType[] = ['score', 'boolean', 'enum', 'text']

/**
 * Default output schema — a small starting point (a boolean + a multi-select enum) the user edits
 * or extends in the schema editor (spec §4).
 */
export const DEFAULT_SCHEMA: EvalSchema = [
  { key: 'resolved', label: 'Resolved', type: 'boolean',
    description: 'Was the customer’s issue actually resolved (not just deflected)?' },
  { key: 'categories', label: 'Categories', type: 'enum', multiple: true,
    options: ['bug', 'billing', 'how-to', 'feature-request'],
    description: 'All categories that apply to this ticket (zero or more).' }
]

/** Default step for score properties when unset. */
export const DEFAULT_SCORE = { min: 1, max: 5, step: 1 } as const

/** True when a base type may be made multi-valued. */
export function allowsMultiple(type: PropertyType): boolean {
  return MULTIPLE_ALLOWED.includes(type)
}

/** Derive a stable camelCase key from a human label (e.g. "Follow Up" → "followUp"). */
export function toCamelKey(raw: string): string {
  const parts = raw.trim().toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean)
  if (parts.length === 0) return ''
  return parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('')
}

/** A fresh, editable property of the given type with sensible defaults (for the schema editor). */
export function blankProperty(type: PropertyType = 'score'): EvalProperty {
  const prop: EvalProperty = { key: '', label: '', type }
  if (type === 'score') Object.assign(prop, DEFAULT_SCORE)
  if (type === 'enum') prop.options = ['', '']
  return prop
}

/**
 * Editor-time validation for one property, given the keys of the *other* rows (for uniqueness).
 * Returns a list of human-readable problems; an empty list means the row is valid. Used for the
 * inline errors in the schema editor; `normalizeSchema` is the stricter at-rest/at-use pass.
 */
export function propertyErrors(prop: EvalProperty, otherKeys: string[]): string[] {
  const errors: string[] = []
  if (!prop.label.trim()) errors.push('Label is required.')
  const key = prop.key.trim()
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
 * Coerce one raw property into a well-formed `EvalProperty`, or return null if it can't be made
 * valid (missing key/label, bad type, enum without options). Full editor-time validation lives in
 * the schema editor (phase 3); this keeps a persisted/loaded schema structurally sound.
 */
function normalizeProperty(raw: unknown): EvalProperty | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<EvalProperty>
  const type = PROPERTY_TYPES.includes(r.type as PropertyType) ? (r.type as PropertyType) : null
  if (!type) return null
  const label = typeof r.label === 'string' ? r.label.trim() : ''
  const key = (typeof r.key === 'string' && r.key.trim() ? r.key.trim() : toCamelKey(label))
  if (!key || !label) return null

  const prop: EvalProperty = { key, label, type }
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
      ? Array.from(new Set(r.options.filter((o): o is string => typeof o === 'string' && !!o.trim()).map((o) => o.trim())))
      : []
    if (options.length < 2) return null // an enum needs ≥2 options to be meaningful
    prop.options = options
  }
  return prop
}

/**
 * Normalize a raw schema: drop invalid properties and de-duplicate keys. Falls back to the
 * default schema when the result is empty (so the app is never left with no way to evaluate).
 */
export function normalizeSchema(raw: unknown): EvalSchema {
  if (!Array.isArray(raw)) return DEFAULT_SCHEMA.map((p) => ({ ...p }))
  const seen = new Set<string>()
  const out: EvalSchema = []
  for (const item of raw) {
    const prop = normalizeProperty(item)
    if (!prop || seen.has(prop.key)) continue
    seen.add(prop.key)
    out.push(prop)
  }
  return out.length > 0 ? out : DEFAULT_SCHEMA.map((p) => ({ ...p }))
}
