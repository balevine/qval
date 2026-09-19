// Compiles the evaluation prompt: system + rules + a machine-readable schema spec + an
// explicit JSON output contract, followed by the batch's rendered tickets. The **static prefix**
// (rules + schema + contract) is identical across batches so it can be prompt-cached. Only the
// **dynamic suffix** (the tickets) varies.
//
// A subagent has no system slot, so engine.mjs inlines `system` at the top of each prompt file
// rather than sending it separately. Same string either way.

/**
 * @typedef {import('@shared/types').EvalProperty} EvalProperty
 * @typedef {import('@shared/types').EvalSchema} EvalSchema
 * @typedef {import('@shared/types').Ticket} Ticket
 *
 * @typedef {object} CompiledPrompt
 * @property {string} system
 * @property {string} staticPrefix Rules + schema spec + output contract, identical across batches.
 * @property {string} dynamicSuffix The rendered tickets for this batch.
 * @property {string} full staticPrefix + dynamicSuffix, what a non-caching provider sends.
 */

export const SYSTEM_PROMPT =
  'You are a meticulous evaluator of customer-support tickets. You read each ticket and score it ' +
  'strictly against the provided rules and output schema. You return only valid JSON — no prose, ' +
  'no markdown fences — conforming exactly to the requested shape.'

/**
 * One line describing a property's allowed value(s), including the `multiple` array wrapping.
 * @param {EvalProperty} p
 * @returns {string}
 */
export function describeProperty(p) {
  const base = (() => {
    switch (p.type) {
      case 'score':
        return `a number from ${p.min} to ${p.max}${p.step && p.step !== 1 ? ` in steps of ${p.step}` : ''}`
      case 'boolean':
        return 'true or false'
      case 'enum':
        return `one of: ${(p.options ?? []).join(' | ')}`
      case 'text':
        return 'a short free-text string'
    }
  })()
  const value = p.multiple ? `an array (zero or more) where each item is ${base}` : base
  const desc = p.description?.trim() ? ` — ${p.description.trim()}` : ''
  return `- "${p.key}": ${value}${desc}`
}

/** A schema-appropriate example value for a property (used in the output-contract example). */
function exampleValue(p) {
  const one = (() => {
    switch (p.type) {
      case 'score':
        return p.min ?? 1
      case 'boolean':
        return true
      case 'enum':
        return (p.options ?? [])[0] ?? ''
      case 'text':
        return 'brief justification'
    }
  })()
  return p.multiple ? [one] : one
}

function schemaSpec(schema) {
  const lines = schema.map(describeProperty).join('\n')
  const exampleValues = Object.fromEntries(schema.map((p) => [p.key, exampleValue(p)]))
  const example = JSON.stringify({ '<ticketId>': exampleValues })
  const keys = schema.map((p) => `"${p.key}"`).join(', ')
  return [
    'OUTPUT SCHEMA — score every ticket on these properties:',
    lines,
    '',
    'OUTPUT CONTRACT:',
    `- Return a single JSON object whose keys are the ticket ids (as strings) shown below.`,
    `- Each value is an object with exactly these keys: ${keys}.`,
    `- Use the exact value types above; for array properties return a JSON array (use [] if none apply).`,
    `- Return only the JSON object — no markdown, no commentary.`,
    `- Example shape: ${example}`
  ].join('\n')
}

/**
 * Render one ticket as its subject + full conversation, roles labeled.
 * @param {Ticket} t
 * @returns {string}
 */
export function renderTicket(t) {
  const header = `### Ticket ${t.id}: ${t.subject} [status: ${t.status}]`
  const body = t.messages
    .map((m) => `[${m.isStaff ? 'STAFF' : 'CUSTOMER'} · ${m.from.name}]: ${m.body}`)
    .join('\n\n')
  return `${header}\n${body}`
}

/**
 * @param {{ rules: string, schema: EvalSchema, tickets: Ticket[] }} args
 * @returns {CompiledPrompt}
 */
export function compilePrompt(args) {
  const { rules, schema, tickets } = args
  const staticPrefix = [
    'RULES — how to score:',
    rules.trim(),
    '',
    schemaSpec(schema)
  ].join('\n')

  const dynamicSuffix = [
    'TICKETS TO EVALUATE:',
    '',
    tickets.map(renderTicket).join('\n\n'),
    '',
    'Return the JSON object now.'
  ].join('\n')

  return { system: SYSTEM_PROMPT, staticPrefix, dynamicSuffix, full: `${staticPrefix}\n\n${dynamicSuffix}` }
}

/** A tiny sample batch for the compiled-prompt preview before a dataset is imported. */
/** @type {Ticket[]} */
export const SAMPLE_PREVIEW_TICKETS = [
  {
    id: 1,
    subject: "Can't log in after password reset",
    status: 'open',
    messages: [
      {
        from: { name: 'Sarah Kim', email: 'sarah.kim@example.com' },
        body: 'I reset my password but still get "invalid credentials" on every attempt. Please help!',
        isStaff: false,
        createdAt: '2026-06-28T09:14:00.000Z'
      },
      {
        from: { name: 'Mike Rodriguez', email: 'mike.rodriguez@company.biz' },
        body: 'Sorry for the trouble, Sarah — I cleared the stale session on our end. Try once more and let me know.',
        isStaff: true,
        createdAt: '2026-06-28T15:42:00.000Z'
      }
    ]
  }
]
