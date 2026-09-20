// Canonical hashing for the two merge-matching identities. Both fingerprints hash a
// canonicalized *content* string (not raw file bytes), so re-exports and reformatting still match
// while any real content change doesn't.
//
// This is the most safety-critical module here. Both fingerprints gate merge, so any drift means
// two files of the same dataset and config quietly stop merging, with no other symptom.

import { createHash } from 'node:crypto'
import { normalizeSchema } from './schema.mjs'

/**
 * @typedef {import('@shared/types').EvalSchema} EvalSchema
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

/** Canonical form of one property (fixed key order; type-specific fields only where relevant). */
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
 * Canonical form of the eval config: the *normalized* schema (so equivalent schemas match) in
 * declared order, plus the trimmed rules text (whitespace-only differences normalized out).
 * @param {EvalSchema} schema
 * @param {string} rules
 * @returns {string}
 */
export function canonicalizeConfig(schema, rules) {
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
 * `sha256:<hex>` over the canonicalized {schema, rules}: the config identity for merge.
 * @param {EvalSchema} schema
 * @param {string} rules
 * @returns {string}
 */
export function configFingerprint(schema, rules) {
  return `sha256:${sha256Hex(canonicalizeConfig(schema, rules))}`
}
