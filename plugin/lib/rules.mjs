/** Minimal starter rules: the free-form context the LLM (and the human) reads before scoring. */
export const DEFAULT_RULES = `Evaluate each support ticket against the output schema below.

Context:
- These are customer support conversations. messages[0] is the customer's opening message; later messages may be staff replies.
- Judge the staff handling of the ticket, not the customer.

Scoring guidance:
- Resolved: true only if the customer's underlying problem was actually addressed, not merely deflected or closed.
- Categories: select every category that applies; use an empty list if none fit.
- Be consistent across tickets.

[Add your own definitions, rubric, and edge-case guidance here.]`

/**
 * Normalize a raw rules value to a string (falls back to the default when absent/invalid).
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeRules(raw) {
  return typeof raw === 'string' ? raw : DEFAULT_RULES
}
