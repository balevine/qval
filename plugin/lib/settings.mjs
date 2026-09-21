// Persisted run settings: defaults, coercion, and partial merge. Kept tolerant on purpose so a
// stale or hand-edited settings file never hard-fails, it just falls back field by field.
//
// There is no provider config here. The LLM evaluation runs inside Claude Code with the ambient
// model, so there is no key, host, model, or parallelism for a user to set.

import { DEFAULT_SCHEMA, normalizeSchema } from './schema.mjs'
import { DEFAULT_RULES, normalizeRules } from './rules.mjs'

/** @typedef {import('@shared/types').Settings} Settings */

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  evaluatorName: '',
  schema: DEFAULT_SCHEMA.map((p) => ({ ...p })),
  rules: DEFAULT_RULES,
  lastDatasetPath: null
}

/**
 * Merge a raw (possibly partial or stale) settings object on top of the defaults, coercing fields.
 * Unknown shapes fall back to defaults, which keeps `settings.json` forward and backward compatible
 * as the model evolves. That includes a file written by a release that still had provider settings,
 * or a save folder to point a file dialog at.
 * @param {unknown} raw
 * @returns {Settings}
 */
export function withDefaults(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}

  return {
    evaluatorName: typeof r.evaluatorName === 'string' ? r.evaluatorName : '',
    schema: r.schema === undefined ? DEFAULT_SCHEMA.map((p) => ({ ...p })) : normalizeSchema(r.schema),
    rules: normalizeRules(r.rules),
    lastDatasetPath: typeof r.lastDatasetPath === 'string' ? r.lastDatasetPath : null
  }
}

/**
 * Merge a partial update over the current settings, then re-normalize. `schema` is replaced
 * wholesale (the editor always sends the full schema).
 * @param {Settings} current
 * @param {Partial<Settings>} partial
 * @returns {Settings}
 */
export function mergeSettings(current, partial) {
  return withDefaults({ ...current, ...partial })
}
