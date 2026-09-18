// Shared knobs for the evaluation pipeline (the app's orchestrator and estimate, and the skill's
// batch planner). Token counts here are deliberately rough. They size a budget, they don't bill.

/** Tickets per batch when nothing else says otherwise. */
export const DEFAULT_BATCH_SIZE = 10
export const MAX_OUTPUT_TOKENS_CEILING = 16_000
/** Safety margin over the estimated output so natural variation doesn't truncate a batch. */
export const OUTPUT_TOKEN_MARGIN = 1.6
const CHARS_PER_TOKEN = 4

/**
 * @typedef {import('@shared/types').EvalProperty} EvalProperty
 * @typedef {import('@shared/types').EvalSchema} EvalSchema
 */

/**
 * Rough output-token cost of one property's value in the returned JSON.
 * @param {EvalProperty} p
 */
function propertyOutputTokens(p) {
  const single = p.type === 'text' ? 35 : p.type === 'enum' ? 6 : 3
  const value = p.multiple ? single * 3 : single // assume ~3 items for multi-valued
  return value + 6 // key + punctuation overhead
}

/**
 * Estimated output tokens for one ticket's values object, given the schema.
 * @param {EvalSchema} schema
 * @returns {number}
 */
export function estimatedOutputTokensPerTicket(schema) {
  return schema.reduce((sum, p) => sum + propertyOutputTokens(p), 8) // + id/braces overhead
}

/**
 * The `max_tokens` budget for a batch: expected output × margin, clamped.
 * @param {number} count
 * @param {EvalSchema} schema
 * @returns {number}
 */
export function maxOutputTokensForBatch(count, schema) {
  const expected = Math.max(1, count) * estimatedOutputTokensPerTicket(schema)
  return Math.min(MAX_OUTPUT_TOKENS_CEILING, Math.max(512, Math.ceil(expected * OUTPUT_TOKEN_MARGIN)))
}

/**
 * Approximate token count of a string (chars/4).
 * @param {string} text
 * @returns {number}
 */
export function approxTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}
