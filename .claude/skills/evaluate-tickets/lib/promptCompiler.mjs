// Port of src/shared/promptCompiler.ts. The compiled string must match the app's exactly, so a
// file scored from the CLI is comparable with one scored in the app under the same config.
//
// One difference in *use*, not in output: a subagent has no system slot, so engine.mjs writes
// `system` inlined at the top of each prompt file rather than sending it separately.

export const SYSTEM_PROMPT =
  'You are a meticulous evaluator of customer-support tickets. You read each ticket and score it ' +
  'strictly against the provided rules and output schema. You return only valid JSON — no prose, ' +
  'no markdown fences — conforming exactly to the requested shape.'

/** One line describing a property's allowed value(s), including the `multiple` array wrapping. */
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

/** Render one ticket as its subject + full conversation, roles labeled. */
export function renderTicket(t) {
  const header = `### Ticket ${t.id}: ${t.subject} [status: ${t.status}]`
  const body = t.messages
    .map((m) => `[${m.isStaff ? 'STAFF' : 'CUSTOMER'} · ${m.from.name}]: ${m.body}`)
    .join('\n\n')
  return `${header}\n${body}`
}

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
