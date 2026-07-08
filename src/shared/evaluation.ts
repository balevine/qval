import type { EvalProperty, EvalSchema } from './types'

/** Shared knobs for the evaluation pipeline (orchestrator + estimate). */
export const DEFAULT_BATCH_SIZE = 10
export const MAX_OUTPUT_TOKENS_CEILING = 16_000
/** Safety margin over the estimated output so natural variation doesn't truncate a batch. */
export const OUTPUT_TOKEN_MARGIN = 1.6
const CHARS_PER_TOKEN = 4

/** Rough output-token cost of one property's value in the returned JSON. */
function propertyOutputTokens(p: EvalProperty): number {
  const single = p.type === 'text' ? 35 : p.type === 'enum' ? 6 : 3
  const value = p.multiple ? single * 3 : single // assume ~3 items for multi-valued
  return value + 6 // key + punctuation overhead
}

/** Estimated output tokens for one ticket's values object, given the schema. */
export function estimatedOutputTokensPerTicket(schema: EvalSchema): number {
  return schema.reduce((sum, p) => sum + propertyOutputTokens(p), 8) // + id/braces overhead
}

/** The `max_tokens` budget for a batch: expected output × margin, clamped. */
export function maxOutputTokensForBatch(count: number, schema: EvalSchema): number {
  const expected = Math.max(1, count) * estimatedOutputTokensPerTicket(schema)
  return Math.min(MAX_OUTPUT_TOKENS_CEILING, Math.max(512, Math.ceil(expected * OUTPUT_TOKEN_MARGIN)))
}

/** Approximate token count of a string (chars/4). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}
