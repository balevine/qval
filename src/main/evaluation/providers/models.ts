import type { ProviderId } from '@shared/types'

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerM: number
  /** USD per 1M output tokens. */
  outputPerM: number
  currency: 'USD'
}

/**
 * ⚠️ Best-effort, HAND-MAINTAINED Anthropic pricing (spec §5/§16). The models API does not return
 * prices, so this table is the only source — it drifts and MUST be verified at build time. Keys
 * are matched exactly first, then by prefix (model ids may carry date suffixes). An unknown model
 * yields `null`, and the cost estimate shows "—" for dollars (token counts still show).
 */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-8': { inputPerM: 15, outputPerM: 75, currency: 'USD' },
  'claude-opus-4': { inputPerM: 15, outputPerM: 75, currency: 'USD' },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15, currency: 'USD' },
  'claude-sonnet-4': { inputPerM: 3, outputPerM: 15, currency: 'USD' },
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5, currency: 'USD' },
  'claude-haiku-4': { inputPerM: 1, outputPerM: 5, currency: 'USD' }
}

/** Local models cost nothing. */
export const LOCAL_PRICING: ModelPricing = { inputPerM: 0, outputPerM: 0, currency: 'USD' }

/** Pricing for a provider+model, or `null` if unknown (Ollama is always free). */
export function getPricing(provider: ProviderId, model: string): ModelPricing | null {
  if (provider === 'ollama') return LOCAL_PRICING
  if (ANTHROPIC_PRICING[model]) return ANTHROPIC_PRICING[model]
  const prefix = Object.keys(ANTHROPIC_PRICING)
    .sort((a, b) => b.length - a.length) // longest (most specific) prefix first
    .find((k) => model.startsWith(k))
  return prefix ? ANTHROPIC_PRICING[prefix] : null
}

/** USD cost for a token usage, or `null` when the model's price is unknown. */
export function costForUsage(
  provider: ProviderId,
  model: string,
  usage: { inputTokens: number; outputTokens: number }
): number | null {
  const p = getPricing(provider, model)
  if (!p) return null
  return (usage.inputTokens / 1_000_000) * p.inputPerM + (usage.outputTokens / 1_000_000) * p.outputPerM
}
