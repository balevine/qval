// Reading and checking a drafted config, the pure half of rules-first drafting. The ambient model
// reads the user's `RULES.md` and writes its draft as JSON (the shape is defined in
// skills/draft/DRAFTING.md). The engine's `draft-check` and `draft-apply` read it through here, so
// the shape is enforced in one place and every rule below is testable with no model at all.
//
// The blocking checks are the schema validation every config already goes through (`schemaErrors`
// under the draft's scorer). What this module adds is the reading of the draft's own envelope and
// the warnings. A warning never blocks. A missing definition still runs, and the scorer quietly
// does worse for it, which is why each one is named for the reviewer rather than left for the
// results to reveal. They are ported from qbench's `draftChecks`.
//
// Engine-only, but free of node built-ins like the rest of the pure modules.

/**
 * @typedef {import('@shared/types').Scorer} Scorer
 */

import { isScorer, OPTION_QUESTION_FIELDS } from './schema.mjs'

/**
 * Past this many Jev questions a reviewer is told to try a few tickets first. Jev takes every
 * question about a ticket in one request, and the most it accepts in one is not published.
 */
export const MANY_QUESTIONS = 20

/** The property fields only the `jev` scorer reads. Under `claude` normalization drops them. */
export const JEV_FIELDS = [
  'instructions',
  'trueDescription',
  'falseDescription',
  'optionDescriptions',
  ...OPTION_QUESTION_FIELDS,
  'levels'
]

/**
 * A drafted config, read but not yet validated as a schema.
 * @typedef {object} Draft
 * @property {Scorer} scorer
 * @property {unknown[]} properties the raw rows, for the engine's per-row validation
 * @property {string} rules the text that becomes `EVAL_RULES.md`
 * @property {Record<string, string>} notes why each property has its shape, by key
 * @property {string[]} removed a short phrase for each part taken out of `RULES.md`
 * @property {string[]} warnings what the drafter says the schema cannot carry
 */

/**
 * One warning for the reviewer. `key` names the property it belongs to, or is null for the draft
 * as a whole.
 * @typedef {{ key: string | null, message: string }} DraftWarning
 */

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string')
const filled = (v) => typeof v === 'string' && v.trim().length > 0

/**
 * Read a drafted answer into its parts, or list every way it is not the agreed shape. Only the
 * envelope is checked here. The rows are left raw so the caller can report per-row problems with
 * the same wording `config` uses.
 * @param {unknown} raw
 * @returns {{ ok: true, draft: Draft } | { ok: false, problems: string[] }}
 */
export function readDraft(raw) {
  if (!isObject(raw)) return { ok: false, problems: ['The draft must be a JSON object.'] }
  const r = /** @type {Record<string, unknown>} */ (raw)
  const problems = []

  if (r.scorer === undefined) problems.push('"scorer" is missing. It must be "claude" or "jev".')
  else if (!isScorer(r.scorer)) problems.push(`"scorer" must be "claude" or "jev". Got ${JSON.stringify(r.scorer)}.`)

  if (!Array.isArray(r.properties)) problems.push('"properties" must be a list of properties.')
  else if (r.properties.length === 0) problems.push('"properties" is empty. The draft has nothing to score.')

  if (typeof r.rules !== 'string') problems.push('"rules" must be the text for EVAL_RULES.md, as a string.')

  if (r.notes !== undefined && !(isObject(r.notes) && Object.values(r.notes).every((v) => typeof v === 'string'))) {
    problems.push('"notes" must be an object from property key to a sentence.')
  }
  if (r.removed !== undefined && !isStringList(r.removed)) problems.push('"removed" must be a list of short phrases.')
  if (r.warnings !== undefined && !isStringList(r.warnings)) problems.push('"warnings" must be a list of sentences.')

  if (problems.length) return { ok: false, problems }

  const trimmedList = (v) => (v === undefined ? [] : /** @type {string[]} */ (v).map((s) => s.trim()).filter(Boolean))
  /** @type {Record<string, string>} */
  const notes = {}
  for (const [key, note] of Object.entries(/** @type {Record<string, string>} */ (r.notes ?? {}))) {
    if (note.trim()) notes[key] = note.trim()
  }
  return {
    ok: true,
    draft: {
      scorer: /** @type {Scorer} */ (r.scorer),
      properties: /** @type {unknown[]} */ (r.properties),
      rules: /** @type {string} */ (r.rules),
      notes,
      removed: trimmedList(r.removed),
      warnings: trimmedList(r.warnings)
    }
  }
}

/**
 * How many questions Jev is sent per ticket for these rows. A multi-select enum is asked as one
 * yes or no question per option, so it counts once per option.
 * @param {unknown[]} rows
 * @returns {number}
 */
export function jevQuestionCount(rows) {
  return rows.reduce((n, row) => {
    const r = isObject(row) ? /** @type {Record<string, any>} */ (row) : {}
    return n + (r.type === 'enum' && r.multiple === true && Array.isArray(r.options) ? r.options.length : 1)
  }, 0)
}

/**
 * Everything a reviewer should look at in a draft that is not an error. Run it on rows that have
 * passed validation, though it reads them defensively either way.
 *
 * Under both scorers a property without a description is named, because the description is the
 * definition the scorer reads. Under `claude` a Jev field is named too, since normalization drops it
 * without a word and its presence means the draft was written for the wrong scorer. Under `jev` the
 * definitions Jev reads are checked one by one: what yes and no mean, each option, each level.
 * @param {unknown[]} rows
 * @param {Scorer} scorer
 * @returns {DraftWarning[]}
 */
export function draftWarnings(rows, scorer) {
  /** @type {DraftWarning[]} */
  const out = []
  for (const row of rows) {
    if (!isObject(row)) continue
    const r = /** @type {Record<string, any>} */ (row)
    const key = typeof r.key === 'string' && r.key.trim() ? r.key.trim() : null
    const warn = (message) => out.push({ key, message })

    if (!filled(r.description)) warn('This property has no description.')

    if (scorer === 'claude') {
      for (const field of JEV_FIELDS) {
        if (r[field] !== undefined) warn(`"${field}" is a Jev field and is ignored under the claude scorer.`)
      }
      continue
    }

    if (r.type === 'boolean' && (!filled(r.trueDescription) || !filled(r.falseDescription))) {
      warn('This property does not say what yes and no each mean.')
    }
    if (r.type === 'enum' && Array.isArray(r.options)) {
      const map = (field) => (isObject(r[field]) ? r[field] : {})
      const descriptions = map('optionDescriptions')
      const options = r.options.filter(filled).map((o) => o.trim())
      for (const option of options) {
        if (!filled(descriptions[option])) warn(`The option '${option}' has no definition.`)
      }
      const multiple = r.multiple === true
      for (const field of ['optionDescriptions', ...OPTION_QUESTION_FIELDS]) {
        // Normalization keys these maps by the options as written, so an entry under a misspelled
        // option would be dropped on apply and its option left undefined.
        for (const named of Object.keys(map(field))) {
          if (!options.includes(named)) warn(`"${field}" names '${named}', which is not one of the options.`)
        }
        if (!multiple && field !== 'optionDescriptions' && r[field] !== undefined) {
          warn(`"${field}" is only read on a multi-select and is ignored here.`)
        }
      }
      if (multiple) {
        const ownQuestions = options.filter((o) => filled(map('optionInstructions')[o]))
        if (ownQuestions.length === 0) {
          warn('Every option is asked the same shared question. Give each option its own instructions.')
        }
        for (const option of ownQuestions) {
          if (!filled(map('optionTrueDescriptions')[option]) || !filled(map('optionFalseDescriptions')[option])) {
            warn(`The option '${option}' does not say what yes and no each mean.`)
          }
        }
      }
    }
    if (r.type === 'score' && Array.isArray(r.levels)) {
      for (const level of r.levels) {
        if (isObject(level) && filled(level.label) && !filled(level.description)) {
          warn(`The level '${level.label.trim()}' has no definition.`)
        }
      }
    }
  }

  if (scorer === 'jev') {
    const count = jevQuestionCount(rows)
    if (count > MANY_QUESTIONS) {
      out.push({
        key: null,
        message:
          `This schema asks Jev ${count} questions about every ticket. Jev takes all of them in one ` +
          'request and the most it accepts in one request is not published, so try it on a few ' +
          'tickets before a full run.'
      })
    }
  }
  return out
}
