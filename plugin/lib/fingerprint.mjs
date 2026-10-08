// Canonical hashing for the two merge-matching identities. Both fingerprints hash a
// canonicalized *content* string (not raw file bytes), so re-exports and reformatting still match
// while any real content change doesn't.
//
// This is the most safety-critical module here. Both fingerprints gate merge, so any drift means
// two files of the same dataset and config quietly stop merging, with no other symptom.

import { createHash } from 'node:crypto'
import { DEFAULT_SCORER, normalizeSchema, OPTION_QUESTION_FIELDS } from './schema.mjs'

/**
 * @typedef {import('@shared/types').EvalProperty} EvalProperty
 * @typedef {import('@shared/types').EvalSchema} EvalSchema
 * @typedef {import('@shared/types').Scorer} Scorer
 * @typedef {import('@shared/types').Ticket} Ticket
 */

/**
 * Reduce the tickets to their meaningful fields in a fixed key order, dropping the file's `meta`
 * and all formatting. Building the objects in explicit order makes `JSON.stringify` deterministic.
 * Two exports of the same tickets therefore fingerprint alike however they were produced or spaced.
 * @param {Ticket[]} tickets
 * @returns {string}
 */
export function canonicalizeTickets(tickets) {
  const canon = tickets.map((t) => ({
    id: t.id,
    subject: t.subject,
    status: t.status,
    messages: (t.messages ?? []).map((m) => ({
      name: m.from?.name ?? '',
      email: m.from?.email ?? '',
      body: m.body,
      isStaff: m.isStaff,
      createdAt: m.createdAt
    }))
  }))
  return JSON.stringify(canon)
}

/**
 * Canonical form of one property (fixed key order; type-specific fields only where relevant).
 * @param {EvalProperty} p
 */
function canonProperty(p) {
  return {
    key: p.key,
    label: p.label,
    type: p.type,
    multiple: p.multiple === true,
    description: p.description?.trim() ?? '',
    min: p.type === 'score' ? p.min : null,
    max: p.type === 'score' ? p.max : null,
    step: p.type === 'score' ? p.step : null,
    options: p.type === 'enum' ? p.options ?? [] : null
  }
}

/**
 * A Jev property adds the text Jev is actually sent. Jev never sees the keys, so two schemas that
 * differ only in an instruction or a level's description ask different questions, and their files
 * must not merge. Option descriptions are listed in option order, not object order.
 * @param {EvalProperty} p
 */
function canonJevProperty(p) {
  const canon = {
    ...canonProperty(p),
    instructions: p.instructions?.trim() ?? '',
    trueDescription: p.type === 'boolean' ? p.trueDescription?.trim() ?? '' : null,
    falseDescription: p.type === 'boolean' ? p.falseDescription?.trim() ?? '' : null,
    optionDescriptions:
      p.type === 'enum' ? (p.options ?? []).map((o) => [o, p.optionDescriptions?.[o]?.trim() ?? '']) : null,
    levels:
      p.type === 'score'
        ? (p.levels ?? []).map((l) => ({ label: l.label, description: l.description?.trim() ?? '' }))
        : null
  }
  // A multi-select's own option questions are hashed only when it has some, so every Jev config
  // written before they existed keeps its fingerprint.
  if (OPTION_QUESTION_FIELDS.some((field) => p[field])) {
    canon.optionQuestions = (p.options ?? []).map((o) => [o, ...OPTION_QUESTION_FIELDS.map((f) => p[f]?.[o]?.trim() ?? '')])
  }
  return canon
}

/**
 * Canonical form of the eval config: the *normalized* schema (so equivalent schemas match) in
 * declared order, plus the trimmed rules text (whitespace-only differences normalized out).
 *
 * A `claude` config hashes exactly the payload it did before scorers existed, with no scorer field
 * in it, so every eval file already written keeps its fingerprint and still merges. Only `jev`
 * adds the scorer and its own fields, which is also what keeps a Jev file and a Claude file of the
 * same rules from ever matching.
 * @param {EvalSchema} schema
 * @param {string} rules
 * @param {Scorer} [scorer]
 * @returns {string}
 */
export function canonicalizeConfig(schema, rules, scorer = DEFAULT_SCORER) {
  if (scorer === 'jev') {
    return JSON.stringify({
      scorer: 'jev',
      schema: normalizeSchema(schema, 'jev').map(canonJevProperty),
      rules: rules.trim()
    })
  }
  return JSON.stringify({
    schema: normalizeSchema(schema).map(canonProperty),
    rules: rules.trim()
  })
}

/**
 * SHA-256 of a UTF-8 string as lowercase hex.
 * @param {string} input
 * @returns {string}
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * `sha256:<hex>` over the canonicalized tickets: the dataset identity for merge.
 * @param {Ticket[]} tickets
 * @returns {string}
 */
export function datasetFingerprint(tickets) {
  return `sha256:${sha256Hex(canonicalizeTickets(tickets))}`
}

/**
 * `sha256:<hex>` over the canonicalized {scorer, schema, rules}: the config identity for merge.
 * @param {EvalSchema} schema
 * @param {string} rules
 * @param {Scorer} [scorer]
 * @returns {string}
 */
export function configFingerprint(schema, rules, scorer = DEFAULT_SCORER) {
  return `sha256:${sha256Hex(canonicalizeConfig(schema, rules, scorer))}`
}
