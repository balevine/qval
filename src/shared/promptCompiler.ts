import type { EvalProperty, EvalSchema, Ticket } from './types'

/**
 * Compiles the evaluation prompt (spec §6): system + rules + a machine-readable schema spec + an
 * explicit JSON output contract, followed by the batch's rendered tickets. The **static prefix**
 * (rules + schema + contract) is identical across batches so it can be prompt-cached; only the
 * **dynamic suffix** (the tickets) varies. All pure — the renderer uses it for the compiled
 * preview and the orchestrator (phase 5) uses it per batch.
 */

export const SYSTEM_PROMPT =
  'You are a meticulous evaluator of customer-support tickets. You read each ticket and score it ' +
  'strictly against the provided rules and output schema. You return only valid JSON — no prose, ' +
  'no markdown fences — conforming exactly to the requested shape.'

export interface CompiledPrompt {
  system: string
  /** Rules + schema spec + output contract — identical across batches (cacheable). */
  staticPrefix: string
  /** The rendered tickets for this batch. */
  dynamicSuffix: string
  /** staticPrefix + dynamicSuffix — what a non-caching provider sends. */
  full: string
}

/** One line describing a property's allowed value(s), including the `multiple` array wrapping. */
export function describeProperty(p: EvalProperty): string {
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
function exampleValue(p: EvalProperty): unknown {
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

function schemaSpec(schema: EvalSchema): string {
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
export function renderTicket(t: Ticket): string {
  const header = `### Ticket ${t.id}: ${t.subject} [status: ${t.status}]`
  const body = t.messages
    .map((m) => `[${m.isStaff ? 'STAFF' : 'CUSTOMER'} · ${m.from.name}]: ${m.body}`)
    .join('\n\n')
  return `${header}\n${body}`
}

export function compilePrompt(args: { rules: string; schema: EvalSchema; tickets: Ticket[] }): CompiledPrompt {
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
export const SAMPLE_PREVIEW_TICKETS: Ticket[] = [
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
