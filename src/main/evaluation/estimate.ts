import type { CostEstimate, Settings, Ticket } from '@shared/types'
import { approxTokens, estimatedOutputTokensPerTicket } from '@shared/evaluation'
import { compilePrompt } from '@shared/promptCompiler'
import { costForUsage, getPricing, modelForSettings } from './providers'
import { SYSTEM_PROMPT } from './providers/common'

const SYSTEM_TOKENS = approxTokens(SYSTEM_PROMPT)

/**
 * Rough pre-run estimate over the target tickets. Input ≈ static prefix (rules+schema) per batch +
 * the rendered conversations; output ≈ tickets × schema-derived per-ticket tokens. Dollars are
 * shown only when the model's price is known (spec §5); Ollama is always $0.
 */
export function estimateRun(settings: Settings, tickets: Ticket[], batchSize: number): CostEstimate {
  const provider = settings.providerId
  const model = modelForSettings(settings)
  const target = tickets.length
  const batches = Math.max(1, Math.ceil(Math.max(1, target) / Math.max(1, batchSize)))

  const sample = tickets.slice(0, Math.min(Math.max(1, batchSize), Math.max(1, target)))
  const compiled = compilePrompt({ rules: settings.rules, schema: settings.schema, tickets: sample })
  const staticTokens = approxTokens(compiled.staticPrefix) + SYSTEM_TOKENS
  const perTicketInput = sample.length > 0 ? approxTokens(compiled.dynamicSuffix) / sample.length : 0

  const estimatedInputTokens = Math.ceil(batches * staticTokens + perTicketInput * target)
  const estimatedOutputTokens = Math.ceil(target * estimatedOutputTokensPerTicket(settings.schema))

  const estimatedCostUsd = costForUsage(provider, model, {
    inputTokens: estimatedInputTokens,
    outputTokens: estimatedOutputTokens
  })

  return {
    provider,
    model,
    targetCount: target,
    batches,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    estimatedCostUsd,
    priceKnown: getPricing(provider, model) !== null,
    currency: 'USD',
    isLocal: provider === 'ollama'
  }
}
