import type { AnthropicConfig, OllamaConfig, Settings } from './types'
import { DEFAULT_SCHEMA, normalizeSchema } from './schema'
import { DEFAULT_RULES, normalizeRules } from './rules'

/** Bounds for the numeric run settings (shared by the UI and validation). */
export const LIMITS = {
  concurrency: { min: 1, max: 16, default: 4 },
  batchSize: { min: 1, max: 100, default: 20 }
} as const

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434'

export const DEFAULT_SETTINGS: Settings = {
  providerId: 'ollama',
  ollama: { host: DEFAULT_OLLAMA_HOST, model: '' },
  anthropic: { model: null },
  evaluatorName: '',
  schema: DEFAULT_SCHEMA.map((p) => ({ ...p })),
  rules: DEFAULT_RULES,
  concurrency: LIMITS.concurrency.default,
  batchSize: LIMITS.batchSize.default,
  defaultDir: null,
  lastWorkingPath: null,
  lastDatasetPath: null
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Merge a raw (possibly partial or stale) settings object on top of the defaults, coercing and
 * clamping fields. Unknown shapes fall back to defaults — this keeps `settings.json` forward/
 * backward compatible as the model evolves.
 */
export function withDefaults(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>
  const ollama = (r.ollama && typeof r.ollama === 'object' ? r.ollama : {}) as Partial<OllamaConfig>
  const anthropic = (r.anthropic && typeof r.anthropic === 'object' ? r.anthropic : {}) as Partial<AnthropicConfig>

  return {
    providerId:
      r.providerId && ['ollama', 'anthropic'].includes(r.providerId)
        ? r.providerId
        : DEFAULT_SETTINGS.providerId,
    ollama: {
      host: typeof ollama.host === 'string' && ollama.host ? ollama.host : DEFAULT_OLLAMA_HOST,
      model: typeof ollama.model === 'string' ? ollama.model : ''
    },
    anthropic: {
      model: typeof anthropic.model === 'string' && anthropic.model ? anthropic.model : null
    },
    evaluatorName: typeof r.evaluatorName === 'string' ? r.evaluatorName : '',
    schema: r.schema === undefined ? DEFAULT_SCHEMA.map((p) => ({ ...p })) : normalizeSchema(r.schema),
    rules: normalizeRules(r.rules),
    concurrency: clampInt(r.concurrency, LIMITS.concurrency.min, LIMITS.concurrency.max, LIMITS.concurrency.default),
    batchSize: clampInt(r.batchSize, LIMITS.batchSize.min, LIMITS.batchSize.max, LIMITS.batchSize.default),
    defaultDir: typeof r.defaultDir === 'string' ? r.defaultDir : null,
    lastWorkingPath: typeof r.lastWorkingPath === 'string' ? r.lastWorkingPath : null,
    lastDatasetPath: typeof r.lastDatasetPath === 'string' ? r.lastDatasetPath : null
  }
}

/**
 * Merge a partial update over the current settings, then re-normalize. Nested `ollama`/`anthropic`
 * objects are merged field-by-field so updating one field preserves its siblings; `schema` is
 * replaced wholesale (the editor always sends the full schema).
 */
export function mergeSettings(current: Settings, partial: Partial<Settings>): Settings {
  return withDefaults({
    ...current,
    ...partial,
    ollama: { ...current.ollama, ...partial.ollama },
    anthropic: { ...current.anthropic, ...partial.anthropic }
  })
}
