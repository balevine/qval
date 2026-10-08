// The output schema: defaults, editor-time validation, and the at-rest/at-use normalization.
// `normalizeSchema` feeds the config fingerprint, so changing what it accepts or how it coerces
// changes which eval files merge with which. Treat it as a wire format, not as a helper.
//
// The JSDoc `@param`/`@returns` throughout lib/ are what the app's TypeScript type-checks against.
// They are plain comments to node, so this folder still runs standalone. The data model they refer
// to is declared once, in src/shared/types.ts.

/**
 * @typedef {import('@shared/types').EvalProperty} EvalProperty
 * @typedef {import('@shared/types').EvalSchema} EvalSchema
 * @typedef {import('@shared/types').PropertyType} PropertyType
 * @typedef {import('@shared/types').Scorer} Scorer
 * @typedef {import('@shared/types').JevLevel} JevLevel
 * @typedef {import('@shared/types').SchemaFile} SchemaFile
 */

/**
 * What scores an evaluation. `claude` is the ambient model through subagents, `jev` is Typesafe's
 * Jev. One file has exactly one, chosen before the schema is written, because the two read
 * different property fields.
 * @type {Scorer[]}
 */
export const SCORERS = ['claude', 'jev']

/** The scorer of anything that predates the field: a bare-array schema file, an old eval file. */
/** @type {Scorer} */
export const DEFAULT_SCORER = 'claude'

/**
 * True when `raw` names a known scorer.
 * @param {unknown} raw
 * @returns {raw is Scorer}
 */
export function isScorer(raw) {
  return typeof raw === 'string' && SCORERS.includes(/** @type {Scorer} */ (raw))
}

/**
 * Tolerant read of a scorer. Anything unknown is `claude`, because that is what every file written
 * before the field existed was scored by. Strict callers (the engine's `config`) check `isScorer`
 * first so a typo is reported rather than quietly read as the default.
 * @param {unknown} raw
 * @returns {Scorer}
 */
export function normalizeScorer(raw) {
  return isScorer(raw) ? raw : DEFAULT_SCORER
}

/** Base types that may be made multi-valued (`multiple: true`). Boolean and text are single-value. */
/** @type {PropertyType[]} */
export const MULTIPLE_ALLOWED = ['score', 'enum']

const PROPERTY_TYPES = ['score', 'boolean', 'enum', 'text']

/** Default output schema: a small starting point (a boolean + a multi-select enum) the user edits. */
/** @type {EvalSchema} */
export const DEFAULT_SCHEMA = [
  { key: 'resolved', label: 'Resolved', type: 'boolean',
    description: 'Was the customer’s issue actually resolved (not just deflected)?' },
  { key: 'categories', label: 'Categories', type: 'enum', multiple: true,
    options: ['bug', 'billing', 'how-to', 'feature-request'],
    description: 'All categories that apply to this ticket (zero or more).' }
]

/**
 * Split an `EVAL_SCHEMA.json` into its scorer and its raw property rows. The file is
 * `{ scorer, properties }`, and a bare array (every file written before the scorer existed) is read
 * as `claude`. The rows come back unnormalized so a strict caller can still report per-row problems.
 * Returns null when the value is neither shape. `scorer` is passed through as found, so check it
 * with `isScorer` or `normalizeScorer` before use.
 * @param {unknown} raw
 * @returns {{ scorer: unknown, properties: unknown[] } | null}
 */
export function parseSchemaFile(raw) {
  if (Array.isArray(raw)) return { scorer: DEFAULT_SCORER, properties: raw }
  if (!raw || typeof raw !== 'object') return null
  const r = /** @type {Record<string, unknown>} */ (raw)
  if (!Array.isArray(r.properties)) return null
  return { scorer: r.scorer === undefined ? DEFAULT_SCORER : r.scorer, properties: r.properties }
}

/**
 * The value written to `EVAL_SCHEMA.json`. Always the wrapped form, so the scorer is never left for
 * a reader to infer.
 * @param {Scorer} scorer
 * @param {EvalSchema} properties
 * @returns {SchemaFile}
 */
export function schemaFile(scorer, properties) {
  return { scorer, properties }
}

/** Default step for score properties when unset. */
export const DEFAULT_SCORE = { min: 1, max: 5, step: 1 }

/**
 * True when a base type may be made multi-valued.
 * @param {PropertyType} type
 * @returns {boolean}
 */
export function allowsMultiple(type) {
  return MULTIPLE_ALLOWED.includes(type)
}

/**
 * Derive a stable camelCase key from a human label (e.g. "Follow Up" → "followUp").
 * @param {string} raw
 * @returns {string}
 */
export function toCamelKey(raw) {
  const parts = raw.trim().toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean)
  if (parts.length === 0) return ''
  return parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('')
}

/**
 * A fresh, editable property of the given type with sensible defaults (for the schema editor).
 * @param {PropertyType} [type]
 * @returns {EvalProperty}
 */
export function blankProperty(type = 'score') {
  const prop = { key: '', label: '', type }
  if (type === 'score') Object.assign(prop, DEFAULT_SCORE)
  if (type === 'enum') prop.options = ['', '']
  return prop
}

/**
 * Validation for one property, given the keys of the *other* rows (for uniqueness). Returns a list
 * of human-readable problems; an empty list means the row is valid. `config` prints these
 * per row; `normalizeSchema` is the stricter at-rest/at-use pass. Rules that span rows (Jev's
 * unique questions) live in `schemaErrors`.
 * @param {EvalProperty} prop
 * @param {string[]} otherKeys
 * @param {Scorer} [scorer]
 * @returns {string[]}
 */
export function propertyErrors(prop, otherKeys, scorer = DEFAULT_SCORER) {
  const errors = []
  if (!String(prop.label ?? '').trim()) errors.push('Label is required.')
  const key = String(prop.key ?? '').trim()
  if (!key) errors.push('Key is required.')
  else if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) errors.push('Key must be camelCase (letters/digits, starting with a letter).')
  else if (otherKeys.includes(key)) errors.push(`Key "${key}" is already used.`)

  if (prop.multiple && !allowsMultiple(prop.type)) errors.push('This type cannot be multi-valued.')

  // A Jev score takes its bounds from its levels when normalized, so a hand-written one need not
  // carry them. Its levels are checked instead, below.
  if (prop.type === 'score' && scorer !== 'jev') {
    const { min, max, step } = prop
    if (typeof min !== 'number' || typeof max !== 'number' || min >= max) errors.push('Score needs min < max.')
    if (typeof step !== 'number' || step <= 0) errors.push('Step must be greater than 0.')
  }
  if (prop.type === 'enum') {
    const opts = (prop.options ?? []).map((o) => o.trim()).filter(Boolean)
    if (opts.length < 2) errors.push('Enum needs at least 2 non-empty options.')
    if (new Set(opts).size !== opts.length) errors.push('Enum options must be unique.')
  }
  if (scorer === 'jev') errors.push(...jevPropertyErrors(prop))
  return errors
}

/**
 * What Jev cannot ask, on top of the shared checks. Jev answers with a choice, a yes or no, or a
 * position on a scale, so free text has nothing to come back as. A score is a scale over named
 * levels, and Jev returns one position per question, so a list of scores has no answer either.
 * @param {EvalProperty} prop
 * @returns {string[]}
 */
function jevPropertyErrors(prop) {
  const errors = []
  if (prop.type === 'text') errors.push('Jev cannot score text properties.')
  if (prop.type === 'score' && prop.multiple) errors.push('Jev cannot score a multi-valued score.')
  // A multi-select whose every option asks its own question never sends the shared one.
  const ownQuestions = optionsWithOwnInstructions(prop)
  if (ownQuestions.length && ownQuestions.length < optionList(prop).length) {
    const missing = optionList(prop).filter((o) => !ownQuestions.includes(o))
    errors.push(`Give every option its own instructions, or none of them. Missing: ${missing.join(', ')}.`)
  }
  if (!ownQuestions.length && (typeof prop.instructions !== 'string' || !prop.instructions.trim())) {
    errors.push('Jev needs instructions (the question itself).')
  }
  if (prop.type === 'score') {
    const levels = Array.isArray(prop.levels) ? prop.levels : []
    if (levels.length < 2) errors.push('A Jev score needs at least 2 levels.')
    // The Typesafe API refuses more than 10. Catching it here stops a draft being approved that
    // would then fail on every ticket of the run.
    if (levels.length > 10) errors.push('A Jev score takes at most 10 levels.')
    if (levels.some((l) => !l || typeof l !== 'object' || typeof l.label !== 'string' || !l.label.trim())) {
      errors.push('Every level needs a label.')
    }
  }
  return errors
}

/**
 * The text Jev is asked for one property: its instructions, then its description. Jev never sees
 * the keys, so this is the whole identity of a question as far as it can tell.
 * @param {EvalProperty} prop
 * @returns {string}
 */
export function jevQuestionText(prop) {
  return [prop.instructions, prop.description]
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The per-option maps a Jev multi-select can carry on top of `optionDescriptions`, so each option
 * is asked as its own question, the way qbench asks one noul per label: its instructions (followed
 * by the option's definition), and what a yes and a no mean.
 */
export const OPTION_QUESTION_FIELDS = ['optionInstructions', 'optionTrueDescriptions', 'optionFalseDescriptions']

/** The trimmed, non-empty options of a property, as written. */
const optionList = (prop) =>
  Array.isArray(prop.options) ? prop.options.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.trim()) : []

/** A per-option map's entry for one option, trimmed, or ''. */
const optionEntry = (map, option) =>
  map && typeof map === 'object' && typeof map[option] === 'string' ? map[option].trim() : ''

/**
 * The options of a multi-select that carry their own instructions. Empty for anything else.
 * @param {EvalProperty} prop
 * @returns {string[]}
 */
export function optionsWithOwnInstructions(prop) {
  if (prop.type !== 'enum' || !prop.multiple) return []
  return optionList(prop).filter((o) => optionEntry(prop.optionInstructions, o))
}

/**
 * The text Jev is asked for one option of a multi-select. An option with its own instructions is
 * asked those, then its definition, built the same way as a property's question. One without is
 * asked the property's shared question with the option named after it.
 * @param {EvalProperty} prop
 * @param {string} option
 * @returns {string}
 */
export function jevOptionText(prop, option) {
  const own = optionEntry(prop.optionInstructions, option)
  if (own) return jevQuestionText({ instructions: own, description: optionEntry(prop.optionDescriptions, option) })
  return `${jevQuestionText(prop)}\n\nOption: ${option}`
}

/**
 * Every question text one property sends Jev. A multi-select with its own option questions sends
 * one per option. Anything else is identified by its own instructions plus description.
 * @param {EvalProperty} prop
 * @returns {{ option: string | null, text: string }[]}
 */
function jevTexts(prop) {
  if (optionsWithOwnInstructions(prop).length) {
    return optionList(prop).map((o) => ({ option: o, text: jevOptionText(prop, o) }))
  }
  return [{ option: null, text: jevQuestionText(prop) }]
}

/**
 * Validation for a whole schema under a scorer: every row's `propertyErrors`, plus the checks that
 * need more than one row. Under `jev` two questions asking the same text are refused, whether they
 * are two properties or two options of one multi-select, since Jev would have no way to give them
 * different answers. Returns one list per row, in row order.
 * @param {EvalProperty[]} props
 * @param {Scorer} [scorer]
 * @returns {string[][]}
 */
export function schemaErrors(props, scorer = DEFAULT_SCORER) {
  const keys = props.map((p) => String(p?.key ?? '').trim())
  const out = props.map((p, i) => propertyErrors(p, keys.filter((_, j) => j !== i).filter(Boolean), scorer))
  if (scorer === 'jev') {
    const asked = props.flatMap((p, row) => jevTexts(p).map((q) => ({ ...q, row })))
    asked.forEach((q, i) => {
      if (!q.text || !asked.some((other, j) => j !== i && other.text === q.text)) return
      out[q.row].push(
        q.option === null
          ? 'Another property asks Jev the same question (instructions plus description).'
          : `The option '${q.option}' asks Jev the same question as another (instructions plus description).`
      )
    })
  }
  return out
}

/** A trimmed non-empty string, or undefined. */
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/**
 * The Jev scale levels of a raw property, lowest first. A level without a label is dropped rather
 * than invented, and fewer than two left means there is no scale (validation says so).
 * @param {unknown} raw
 * @returns {JevLevel[] | null}
 */
function normalizeLevels(raw) {
  if (!Array.isArray(raw)) return null
  const levels = []
  for (const l of raw) {
    const label = l && typeof l === 'object' ? text(l.label) : undefined
    if (!label) continue
    const description = text(l.description)
    levels.push(description ? { label, description } : { label })
  }
  return levels.length >= 2 ? levels : null
}

/**
 * A per-option map of text, keyed by the options as normalized and in option order, so an entry can
 * never outlive its option or reorder the hash. Null when no option has an entry.
 * @param {unknown} raw
 * @param {string[]} options
 * @returns {Record<string, string> | null}
 */
function optionMap(raw, options) {
  if (!raw || typeof raw !== 'object') return null
  const map = {}
  for (const o of options) {
    const t = text(raw[o])
    if (t) map[o] = t
  }
  return Object.keys(map).length ? map : null
}

/**
 * Coerce one raw property into a well-formed property, or return null if it can't be made valid
 * (missing key/label, bad type, enum without options). The Jev fields are kept only under `jev`.
 * A Claude schema is stripped of them so that it stays byte-for-byte what it was before they
 * existed, which is what keeps every existing config fingerprint unchanged.
 * @param {unknown} raw
 * @param {Scorer} scorer
 * @returns {EvalProperty | null}
 */
function normalizeProperty(raw, scorer) {
  if (!raw || typeof raw !== 'object') return null
  const r = raw
  const type = PROPERTY_TYPES.includes(r.type) ? r.type : null
  if (!type) return null
  const label = typeof r.label === 'string' ? r.label.trim() : ''
  const key = typeof r.key === 'string' && r.key.trim() ? r.key.trim() : toCamelKey(label)
  if (!key || !label) return null

  const prop = { key, label, type }
  if (typeof r.description === 'string' && r.description.trim()) prop.description = r.description
  if (r.multiple === true && allowsMultiple(type)) prop.multiple = true

  if (type === 'score') {
    const min = typeof r.min === 'number' && Number.isFinite(r.min) ? r.min : DEFAULT_SCORE.min
    const max = typeof r.max === 'number' && Number.isFinite(r.max) ? r.max : DEFAULT_SCORE.max
    prop.min = Math.min(min, max)
    prop.max = Math.max(min, max)
    prop.step = typeof r.step === 'number' && r.step > 0 ? r.step : DEFAULT_SCORE.step
  }
  if (type === 'enum') {
    const options = Array.isArray(r.options)
      ? Array.from(new Set(r.options.filter((o) => typeof o === 'string' && !!o.trim()).map((o) => o.trim())))
      : []
    if (options.length < 2) return null // an enum needs ≥2 options to be meaningful
    prop.options = options
  }
  if (scorer === 'jev') addJevFields(prop, r)
  return prop
}

/**
 * Copy the Jev fields that apply to this property's type onto it. A score with levels takes its
 * bounds from them (`0..levels-1`, step 1), so Jev's fractional answer rounds to a level through
 * the same clamp-and-snap every score already goes through.
 * @param {EvalProperty} prop
 * @param {Record<string, any>} r
 */
function addJevFields(prop, r) {
  const instructions = text(r.instructions)
  if (instructions) prop.instructions = instructions
  if (prop.type === 'boolean') {
    const t = text(r.trueDescription)
    const f = text(r.falseDescription)
    if (t) prop.trueDescription = t
    if (f) prop.falseDescription = f
  }
  if (prop.type === 'enum') {
    // Only a multi-select asks one question per option, so only it keeps the per-option questions.
    const fields = prop.multiple ? ['optionDescriptions', ...OPTION_QUESTION_FIELDS] : ['optionDescriptions']
    for (const field of fields) {
      const map = optionMap(r[field], prop.options ?? [])
      if (map) prop[field] = map
    }
  }
  if (prop.type === 'score') {
    const levels = normalizeLevels(r.levels)
    if (levels) {
      prop.levels = levels
      prop.min = 0
      prop.max = levels.length - 1
      prop.step = 1
    }
  }
}

/**
 * Normalize a raw schema: drop invalid properties and de-duplicate keys. Falls back to the default
 * schema when the result is empty (so there is never no way to evaluate).
 * @param {unknown} raw
 * @param {Scorer} [scorer]
 * @returns {EvalSchema}
 */
export function normalizeSchema(raw, scorer = DEFAULT_SCORER) {
  if (!Array.isArray(raw)) return DEFAULT_SCHEMA.map((p) => ({ ...p }))
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const prop = normalizeProperty(item, scorer)
    if (!prop || seen.has(prop.key)) continue
    seen.add(prop.key)
    out.push(prop)
  }
  return out.length > 0 ? out : DEFAULT_SCHEMA.map((p) => ({ ...p }))
}
