// One Jev request per ticket, and the reading of what comes back. Ported from qbench's `toJev` and
// `readJev`, renamed to Qval's property model.
//
// Every question about a ticket rides in a single request. Jev is never told which property a
// question belongs to (the question ids here are only how an answer is matched back), so the
// compiled text is all it knows about a question. That text is `jevQuestionText` (or, for one
// option of a multi-select, `jevOptionText`), the same string schema validation requires to be
// unique, so what was checked is exactly what is sent.
//
// Reading never trusts the response's shape. Each answer is turned into the raw value a Claude
// subagent would have written for that property and then handed to `validateValues`, so a Jev
// answer is coerced, clamped, or dropped by the same rules and leaves the same `issues[]` trail.
//
// No node built-ins here: it is pure, like the prompt compiler it reuses.

import { renderTicket } from './promptCompiler.mjs'
import { jevOptionText, jevQuestionText } from './schema.mjs'
import { validateValues } from './evalValidate.mjs'

/**
 * @typedef {import('@shared/types').EvalProperty} EvalProperty
 * @typedef {import('@shared/types').EvalSchema} EvalSchema
 * @typedef {import('@shared/types').EvalResult} EvalResult
 * @typedef {import('@shared/types').Ticket} Ticket
 *
 * @typedef {object} JevQuestion
 * @property {'noul' | 'choice' | 'score'} type
 * @property {string} instructions
 * @property {Record<string, string> | string[]} criteria
 *
 * @typedef {object} JevRequest
 * @property {{ support_guidelines: string, support_ticket: string }} state
 * @property {string} model
 * @property {Record<string, JevQuestion>} questions
 */

/**
 * The model slug every request asks for, and what the evaluator records. It has to be known before
 * the run for the model lock to compare against, which the model Jev reports back is not.
 */
export const JEV_MODEL = 'jev-latest'

/** A noul at or above this probability reads as yes. Fixed until there is a reason to tune it. */
export const NOUL_YES_AT = 0.5

/**
 * The question id of one option of a multi-select enum, asked as its own yes or no. Keys are
 * camelCase, so an underscore can never collide with another property's key. The option's index
 * is used rather than its text, which may hold anything.
 * @param {string} key
 * @param {number} index
 * @returns {string}
 */
export function optionQuestionId(key, index) {
  return `${key}_opt${index}`
}

/** What a yes and a no mean, each falling back to the label when nothing was written. */
function noulCriteria(p) {
  const label = p.label.trim()
  return {
    true: p.trueDescription?.trim() || `"${label}" describes this ticket.`,
    false: p.falseDescription?.trim() || `"${label}" does not describe this ticket.`
  }
}

/**
 * What a yes and a no mean for one option of a multi-select. An option asked its own question
 * already carries its definition in the instructions (as qbench's grouped nouls do), so its yes and
 * no are what was written for them. One asked the shared question has its definition as the yes.
 * @param {EvalProperty} p
 * @param {string} o
 */
function optionCriteria(p, o) {
  const meaning = p.optionDescriptions?.[o]?.trim()
  const ownQuestion = !!p.optionInstructions?.[o]?.trim()
  const fallbackTrue = meaning && !ownQuestion ? `"${o}" applies. ${meaning}` : `"${o}" applies to this ticket.`
  return {
    true: p.optionTrueDescriptions?.[o]?.trim() || fallbackTrue,
    false: p.optionFalseDescriptions?.[o]?.trim() || `"${o}" does not apply to this ticket.`
  }
}

/**
 * The Jev questions one property becomes, keyed by question id. A multi-select enum becomes one
 * noul per option, each asked a text that names its option so no two of them read the same.
 * @param {EvalProperty} p
 * @returns {Record<string, JevQuestion>}
 */
export function jevQuestions(p) {
  const instructions = jevQuestionText(p)
  if (p.type === 'boolean') {
    return { [p.key]: { type: 'noul', instructions, criteria: noulCriteria(p) } }
  }
  if (p.type === 'enum' && p.multiple) {
    const out = {}
    ;(p.options ?? []).forEach((o, i) => {
      out[optionQuestionId(p.key, i)] = { type: 'noul', instructions: jevOptionText(p, o), criteria: optionCriteria(p, o) }
    })
    return out
  }
  if (p.type === 'enum') {
    const criteria = {}
    for (const o of p.options ?? []) criteria[o] = p.optionDescriptions?.[o]?.trim() || o
    return { [p.key]: { type: 'choice', instructions, criteria } }
  }
  if (p.type === 'score') {
    const criteria = (p.levels ?? []).map((l) => l.description?.trim() || l.label.trim())
    return { [p.key]: { type: 'score', instructions, criteria } }
  }
  // Text and multi-valued scores are refused by schema validation under `jev`, so a schema that
  // got this far never holds one. Sending nothing for it is the safe reading if one slips through.
  return {}
}

/**
 * Everything Jev is given about one ticket. The ticket goes through the same fenced renderer the
 * Claude prompt uses, so both scorers see the same text.
 * @param {{ rules: string, schema: EvalSchema, ticket: Ticket }} args
 * @returns {JevRequest}
 */
export function toJev(args) {
  const questions = {}
  for (const p of args.schema) Object.assign(questions, jevQuestions(p))
  return {
    state: { support_guidelines: args.rules.trim(), support_ticket: renderTicket(args.ticket) },
    model: JEV_MODEL,
    questions
  }
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * A noul probability as a yes or no, or null when there is no usable probability.
 * @param {unknown} answer
 * @returns {boolean | null}
 */
function noulOf(answer) {
  const p = isObject(answer) ? num(answer.noul) : null
  return p === null ? null : p >= NOUL_YES_AT
}

/**
 * The raw value one property's answer stands for, in the shape a Claude subagent would write it,
 * or null when nothing usable came back. Null is deliberate: `validateValues` records it as a drop,
 * which is what puts the ticket in front of `--mode remaining`. A missing key would be skipped
 * without an issue.
 */
function rawValue(p, answers) {
  if (p.type === 'enum' && p.multiple) {
    // A set missing a member is not the set that was asked for, so one unanswered option drops the
    // whole property rather than reading it as "no".
    const picks = (p.options ?? []).map((_, i) => noulOf(answers[optionQuestionId(p.key, i)]))
    if (picks.some((x) => x === null)) return null
    return (p.options ?? []).filter((_, i) => picks[i])
  }
  const answer = answers[p.key]
  if (!isObject(answer)) return null
  if (p.type === 'boolean') return noulOf(answer)
  if (p.type === 'enum') return typeof answer.choice === 'string' ? answer.choice : null
  if (p.type === 'score') return num(answer.score)
  return null
}

/**
 * Read one Jev response into a ticket's result. Values pass through the per-value validation, so a
 * fractional score is snapped to its nearest level (and recorded as `clamped` with what Jev said),
 * and an off-schema choice is dropped. The model Jev reports is kept as metadata on the result.
 * @param {unknown} raw the parsed response body
 * @param {EvalSchema} schema
 * @param {{ ticketId: number, evaluatedAt: string }} at
 * @returns {EvalResult}
 */
export function readJev(raw, schema, at) {
  const reportedModel = isObject(raw) && typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null
  const base = { ticketId: at.ticketId, evaluatedAt: at.evaluatedAt, ...(reportedModel ? { reportedModel } : {}) }
  if (!isObject(raw) || !isObject(raw.answers)) {
    return { ...base, values: {}, error: 'The Jev response carried no answers.' }
  }
  const answers = raw.answers
  const rawValues = Object.fromEntries(schema.map((p) => [p.key, rawValue(p, answers)]))
  const { values, issues } = validateValues(rawValues, schema)
  return { ...base, values, error: null, ...(issues.length ? { issues } : {}) }
}
