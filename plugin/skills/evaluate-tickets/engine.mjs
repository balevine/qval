// Deterministic engine for the evaluate-tickets skill. Owns everything the LLM must NOT: config
// validation, both fingerprints, target selection, batching, prompt compilation, per-value
// validation and repair, retry accounting, eval-file assembly, and atomic writes. The only thing
// left to the ambient Claude subagents is judgment (see SKILL.md). A Jev run has no subagents at
// all: `jev` sends each ticket to Typesafe itself and reads the answers in Node.
//
// Subcommands:
//   init                  write the missing config files (EVAL_RULES.md, EVAL_SCHEMA.json) into
//                         the current directory from the starter constants. Exits 3 when it created
//                         one, meaning "stop here and let the user edit them".
//   config                validate the config for its scorer and print the property table + config
//                         fingerprint
//          [--write]      rewrite EVAL_SCHEMA.json in normalized, wrapped form (after a passing check)
//          [--preview]    print the compiled static prefix the model will read
//          [--rules <file>] [--schema <file>]
//   draft-check --scorer claude|jev [--draft <file>]
//                         validate a drafted config (default .qval-run/draft.json, shape in
//                         ../draft/DRAFTING.md) and print its property table, notes, warnings, and
//                         what was taken out of RULES.md. Writes nothing. The draft subcommands are
//                         run by /qval:draft, which has no engine of its own and calls this one.
//   draft-apply [--draft <file>]
//                         re-validate the draft, then write EVAL_SCHEMA.json (normalized, wrapped)
//                         and EVAL_RULES.md. Never touches RULES.md, which stays the user's source.
//   plan     --tickets <file> --model "<name>" [--eval-file <file>] [--rules <file>]
//            [--schema <file>] [--mode all|remaining|selection --ids 1,2,3] [--batch-size 10]
//   assemble --round <r>
//   retry    --round 1
//   jev      --tickets <file> [--eval-file <file>] [--rules <file>] [--schema <file>]
//            [--mode all|remaining|selection --ids 1,2,3] [--concurrency 4] [--resume]
//                         score a jev config in Node through Typesafe's API, no subagents. Needs
//                         $TYPESAFE_API_KEY. --resume continues the last jev run of the same eval
//                         file and criteria, re-sending only tickets with no saved response.
//   status   [--eval-file <file>]
//
// Two directories, both under the user's working directory, and neither one configurable.
//
// .qval-run/ holds the working files for a run:
//   run-context.json      what this run is doing (which tickets, which model, which eval file)
//   round-<r>.json        which tickets went into which batch, for round <r>
//   prompt-<r>-<i>.txt    the text handed to the subagent for batch <i>
//   batch-<r>-<i>.json    the answer that subagent wrote back, before any checking
//   jev/<ticketId>.json   the raw Jev response for one ticket, written before it is read
//   draft.json            a drafted config waiting for the user's approval (not part of a run)
// `plan` and `jev` delete the per-run kinds at the start of a run (not run-context.json, which
// they rewrite, and not draft.json), so a run can never read the last one's files by mistake.
// `jev --resume` is the one exception, and it only resumes the run that wrote them. /qval:review
// keeps its own files here too and those are left alone.
//
// qval-output/ holds the eval file, which is the point of the whole exercise. It is kept out of
// .qval-run/ because that directory is safe to delete and this file is not.
//
// stdout is deliberately a short summary: the engine reads batch files in Node, so ticket content
// and scored values never round-trip through Claude's context.
//
// Exit codes are control flow for the skill: 0 ok, 1 usage, 2 unusable input (missing file, bad
// JSON, invalid schema, fingerprint or model mismatch, a live review session holding the eval
// file), 3 scaffolded (stop and let the user edit).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { flagValue, parseArgs } from '../../lib/args.mjs'
import { atomicWriteJson, atomicWriteText, readJson } from '../../lib/fsUtil.mjs'
import { draftWarnings, readDraft } from '../../lib/draft.mjs'
import {
  DEFAULT_SCHEMA,
  DEFAULT_SCORER,
  isScorer,
  normalizeSchema,
  parseSchemaFile,
  schemaErrors,
  SCORERS,
  schemaFile
} from '../../lib/schema.mjs'
import { DEFAULT_RULES, normalizeRules } from '../../lib/rules.mjs'
import { configFingerprint, datasetFingerprint } from '../../lib/fingerprint.mjs'
import { defaultEvalPath, evalSearchDirs, RUN_DIR, samePath } from '../../lib/paths.mjs'
import { nowIso, pidAlive } from '../../lib/host.mjs'
import { compilePrompt, SYSTEM_PROMPT } from '../../lib/promptCompiler.mjs'
import { parseTicketsFile } from '../../lib/tickets.mjs'
import { validateValues } from '../../lib/evalValidate.mjs'
import { pluginVersion } from '../../lib/version.mjs'
import { JEV_MODEL, readJev, toJev } from '../../lib/jev.mjs'
import { apiKeyFromEnv, KEY_VARIABLE, postSystemOne, redactKey } from '../../lib/typesafe.mjs'
import {
  adoptConfig,
  applyLlmResults,
  CLAUDE_CODE_PROVIDER,
  TYPESAFE_PROVIDER,
  configLocked,
  createWorkingFile,
  isScoredResult,
  lockedLlmProvider,
  mergeResults,
  needsAttention,
  normalizeEvalFile,
  ownResults,
  summarizeEvalFile
} from '../../lib/evalFile.mjs'

const EXIT = { OK: 0, USAGE: 1, INPUT: 2, SCAFFOLDED: 3 }

const PROPERTY_TYPES = ['score', 'boolean', 'enum', 'text']
const DEFAULT_RULES_FILE = 'EVAL_RULES.md'
const DEFAULT_SCHEMA_FILE = 'EVAL_SCHEMA.json'
const RUN_CONTEXT_FILE = 'run-context.json'
/** Where the drafter writes its answer unless `--draft` says otherwise. */
const DRAFT_FILE = 'draft.json'
/** Written by `qval serve` in the same directory. Read (never written) to spot a live review. */
const REVIEW_SESSION_FILE = 'review-session.json'
/** Tickets per batch when `--batch-size` says otherwise. Bigger batches mean fewer subagents and
 *  less overhead, but a truncated response loses more tickets at once. */
const DEFAULT_BATCH_SIZE = 10
/** Under `.qval-run/`, one raw Jev response per ticket, `<ticketId>.json`. Per-run scratch. */
const JEV_DIR = 'jev'
/** Jev requests in flight at once when `--concurrency` says otherwise. Each request is one ticket
 *  with every question, so a few in parallel keeps a large run moving without inviting 429s. */
const DEFAULT_JEV_CONCURRENCY = 4
/** How many distinct failures the `jev` summary spells out. The rest are counted, not listed. */
const JEV_ERRORS_SHOWN = 3
// What produced these scores is recorded on the evaluator as `CLAUDE_CODE_PROVIDER`, imported from
// lib/evalFile.mjs rather than spelled again here. It gates PROVIDER_LOCKED below, so a second copy
// that drifted would refuse a file this very skill wrote.
// `meta.appVersion` is read from the plugin manifest (see ../../lib/version.mjs), never kept here.
// The manifest ships inside the plugin, so this works from a copied skill folder too, which is what
// the old hard-coded constant was working around.

const enginePath = fileURLToPath(import.meta.url)

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

function fail(line, ...rest) {
  console.error(line)
  for (const r of rest) console.error(r)
  process.exit(EXIT.INPUT)
}

function usage(line, ...rest) {
  console.error(line)
  for (const r of rest) console.error(r)
  process.exit(EXIT.USAGE)
}

function writeJsonSync(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2))
}

function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ── config loading + validation ───────────────────────────────────────────────

/**
 * Row-level validation for a hand-authored schema file, under its scorer. `schemaErrors` is the
 * shared check and assumes every row is already an object of a known type, so those guards are
 * added here. A row typed `"rating"` passes `schemaErrors` but `normalizeSchema` silently drops it.
 * Returns one list per row, in row order.
 */
function rowErrors(raw, scorer) {
  const isRow = (r) => !!r && typeof r === 'object' && !Array.isArray(r)
  // `schemaErrors` reads `.label`/`.key` as strings; a raw file may hold anything.
  const rows = raw.map((r) =>
    isRow(r) ? { ...r, label: String(r.label ?? ''), key: String(r.key ?? '') } : { key: '', label: '' }
  )
  const shared = schemaErrors(rows, scorer)
  return raw.map((r, i) => {
    if (!isRow(r)) return ['Property must be a JSON object.']
    const typeError = PROPERTY_TYPES.includes(r.type) ? [] : [`Type must be one of: ${PROPERTY_TYPES.join(' | ')}.`]
    return [...typeError, ...shared[i]]
  })
}

/** Load rules + schema from disk, exiting with a specific reason when either is unusable. */
function loadConfig(args) {
  const rulesPath = resolve(args.rules || DEFAULT_RULES_FILE)
  const schemaPath = resolve(args.schema || DEFAULT_SCHEMA_FILE)

  const hint = `HINT run: node ${enginePath} init`
  if (!existsSync(rulesPath)) fail(`MISSING_RULES ${rulesPath}`, hint)
  if (!existsSync(schemaPath)) fail(`MISSING_SCHEMA ${schemaPath}`, hint)

  const rules = normalizeRules(readFileSync(rulesPath, 'utf8'))

  let raw
  try {
    raw = JSON.parse(readFileSync(schemaPath, 'utf8'))
  } catch (err) {
    fail(`BAD_JSON ${schemaPath}`, `  ${err.message}`)
  }
  const parsed = parseSchemaFile(raw)
  if (!parsed) {
    fail(
      `BAD_SCHEMA ${schemaPath}`,
      '  The schema file must be { "scorer": "claude" | "jev", "properties": [...] } (or a bare array, read as claude).'
    )
  }
  if (!isScorer(parsed.scorer)) {
    fail(`BAD_SCORER ${schemaPath}`, `  "scorer" must be one of: ${SCORERS.join(' | ')}. Got ${JSON.stringify(parsed.scorer)}.`)
  }
  if (parsed.properties.length === 0) fail(`SCHEMA_EMPTY ${schemaPath}`, '  Add at least one property to evaluate.')

  return { rulesPath, schemaPath, rules, scorer: parsed.scorer, raw: parsed.properties }
}

const typeLabel = (row) => `${row && typeof row === 'object' ? (row.type ?? '?') : '?'}${row?.multiple === true ? '[]' : ''}`

/** The right-hand column: the bounds of a score, the options of an enum. */
function detailOf(row) {
  if (!row || typeof row !== 'object') return '-'
  if (row.type === 'score' && Array.isArray(row.levels)) {
    return `levels ${row.levels.map((l) => String(l?.label ?? '?').trim()).join(' | ')}`
  }
  if (row.type === 'score') return `${row.min ?? '?'}..${row.max ?? '?'} step ${row.step ?? '?'}`
  if (row.type === 'enum') return Array.isArray(row.options) ? row.options.join(' | ') : '(no options)'
  return '-'
}

function printTable(raw) {
  // Key and label are shown trimmed because that is what gets stored and hashed; a row whose key
  // is only whitespace shows as empty and its "Key is required." error explains why.
  const rows = raw.map((row, i) => [
    String(i + 1),
    String(row?.key ?? '').trim(),
    typeLabel(row),
    String(row?.label ?? '').trim(),
    detailOf(row)
  ])
  const head = ['#', 'KEY', 'TYPE', 'LABEL', 'DETAIL']
  const width = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)))
  const line = (cells) => '  ' + cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(width[i]))).join('  ')
  console.log(line(head))
  for (const r of rows) console.log(line(r))
}

/**
 * Validate every row under the scorer and report per-row problems. Exits non-zero on any error so
 * the skill stops rather than planning a run against a schema the scorer can't satisfy.
 */
function checkRows(raw, schemaPath, scorer) {
  const failures = []
  rowErrors(raw, scorer).forEach((messages, i) => {
    for (const message of messages) failures.push({ index: i, row: raw[i], message })
  })

  if (failures.length > 0) {
    const bad = new Set(failures.map((f) => f.index))
    console.error('')
    console.error('ERRORS')
    for (const f of failures) {
      const name = String(f.row?.key ?? '').trim() || String(f.row?.label ?? '').trim() || '(unnamed)'
      console.error(`  #${f.index + 1} ${name}: ${f.message}`)
    }
    console.error(`SCHEMA_INVALID ${failures.length} error(s) across ${bad.size} of ${raw.length} properties`)
    console.error(`FILE ${schemaPath}`)
    process.exit(EXIT.INPUT)
  }

  // A valid row can still be dropped by the normalizer (they are independent passes), and a
  // silently shorter schema is exactly the drift that breaks fingerprint matching.
  const schema = normalizeSchema(raw, scorer)
  if (schema.length !== raw.length) {
    fail(
      `SCHEMA_INVALID normalization dropped ${raw.length - schema.length} of ${raw.length} properties`,
      `FILE ${schemaPath}`
    )
  }
  return schema
}

// ── init ──────────────────────────────────────────────────────────────────────

/**
 * The starter config, written from the same constants the review session's settings default to.
 * They are one definition on purpose. Both copies are hashed into the config fingerprint, so two
 * users who each accepted the defaults would get files that refuse to merge if these ever drifted.
 * Only `/qval:draft` runs `init`, and only when the user asks for the starter config.
 * @param {string} name
 * @returns {string}
 */
function starterConfig(name) {
  return name === DEFAULT_SCHEMA_FILE
    ? `${JSON.stringify(schemaFile(DEFAULT_SCORER, DEFAULT_SCHEMA), null, 2)}\n`
    : `${DEFAULT_RULES}\n`
}

function cmdInit() {
  let created = 0
  for (const name of [DEFAULT_RULES_FILE, DEFAULT_SCHEMA_FILE]) {
    const dest = resolve(name)
    if (existsSync(dest)) {
      console.log(`EXISTS ${dest}`)
      continue
    }
    writeFileSync(dest, starterConfig(name))
    console.log(`CREATED ${dest}`)
    created++
  }
  if (created === 0) {
    console.log('READY both config files are already present')
    return
  }
  console.log(`NEXT edit the starter file(s) above by hand or in /qval:review, then run: node ${enginePath} config`)
  // Non-zero on purpose: the starter config is a placeholder, not a config anybody meant to run.
  process.exit(EXIT.SCAFFOLDED)
}

// ── config ────────────────────────────────────────────────────────────────────

async function cmdConfig(args) {
  const { rulesPath, schemaPath, rules, scorer, raw } = loadConfig(args)

  console.log(`SCORER ${scorer}`)
  console.log(`RULES ${rulesPath} · ${rules.trim().length} chars`)
  console.log(`SCHEMA ${schemaPath} · ${raw.length} propert${raw.length === 1 ? 'y' : 'ies'}`)
  console.log('')
  printTable(raw)

  const schema = checkRows(raw, schemaPath, scorer)
  const fingerprint = configFingerprint(schema, rules, scorer)

  if (args.preview && scorer !== 'claude') {
    // The compiled prompt is what Claude's subagents read. Jev is sent a different request, and
    // printing the Claude prompt for a Jev config would show text that is never sent.
    console.log('')
    console.log(`PREVIEW_UNAVAILABLE there is no prompt preview for the ${scorer} scorer`)
  } else if (args.preview) {
    const { staticPrefix } = compilePrompt({ rules, schema, tickets: [] })
    console.log('')
    console.log(`PREVIEW static prefix (rules + schema spec + output contract) · ${staticPrefix.length} chars`)
    console.log('-'.repeat(78))
    console.log(staticPrefix)
    console.log('-'.repeat(78))
  }

  if (args.write) {
    // Always the wrapped form, so a bare array from before scorers existed gains its scorer here.
    const wrapped = schemaFile(scorer, schema)
    const next = JSON.stringify(wrapped, null, 2)
    const current = readFileSync(schemaPath, 'utf8')
    if (current.trim() === next.trim()) {
      console.log('')
      console.log(`UNCHANGED ${schemaPath} is already normalized`)
    } else {
      await atomicWriteJson(schemaPath, wrapped)
      console.log('')
      console.log(`WROTE ${schemaPath} · ${schema.length} propert${schema.length === 1 ? 'y' : 'ies'}`)
    }
  }

  console.log('')
  console.log(`CONFIG OK · ${schema.length} propert${schema.length === 1 ? 'y' : 'ies'}`)
  console.log(`FINGERPRINT ${fingerprint}`)
}

// ── draft-check / draft-apply ─────────────────────────────────────────────────

/**
 * Read the drafted config and validate it, exiting with every problem when it cannot be applied.
 * Both commands go through here, so `draft-apply` re-checks a draft that may have been edited since
 * it was checked rather than trusting that it passed once.
 */
async function loadDraft(args, expectedScorer) {
  const draftPath = resolve(flagValue(args, 'draft') ?? join(RUN_DIR, DRAFT_FILE))
  if (!existsSync(draftPath)) fail(`MISSING_DRAFT ${draftPath}`, '  Write the draft there first (the shape is in skills/draft/DRAFTING.md).')
  const raw = await readJson(draftPath)
  if (raw === null) fail(`BAD_JSON ${draftPath}`, '  The draft is not valid JSON.')

  const read = readDraft(raw)
  if (!read.ok) fail(`DRAFT_INVALID ${draftPath}`, ...read.problems.map((p) => `  ${p}`))
  const { draft } = read
  if (expectedScorer && draft.scorer !== expectedScorer) {
    fail(
      `SCORER_MISMATCH ${draftPath}`,
      `  The draft is for ${draft.scorer}, but --scorer says ${expectedScorer}.`,
      '  Redraft from RULES.md for the scorer the user chose.'
    )
  }

  // The same per-row validation `config` runs, so a draft that passes here is a config
  // that passes there. It exits with the per-row ERRORS block on any problem.
  const schema = checkRows(draft.properties, draftPath, draft.scorer)
  const rules = normalizeRules(draft.rules)
  return { draftPath, draft, schema, rules, fingerprint: configFingerprint(schema, rules, draft.scorer) }
}

/**
 * Eval files here that were scored under criteria other than these. Replacing the config never
 * touches them, since each carries its own snapshot, and `plan` refuses to score the new criteria
 * into one with `CONFIG_MISMATCH`. Listing them up front means the user hears it before approving
 * rather than at the next run. A file with no scores yet is left off, because the next run or
 * review session adopts the new config into it rather than refusing.
 */
async function evalFilesUnderOtherCriteria(fingerprint) {
  const out = []
  for (const dir of evalSearchDirs(process.cwd())) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.qval.json')).sort()) {
      const raw = await readJson(join(dir, name))
      const file = raw ? normalizeEvalFile(raw) : null
      if (file && file.meta.config.fingerprint !== fingerprint && configLocked(file)) out.push(join(dir, name))
    }
  }
  return out
}

function printEvalFilesUnderOtherCriteria(paths) {
  if (!paths.length) return
  console.log('')
  console.log(`OTHER_CRITERIA ${plural(paths.length, 'eval file was', 'eval files were')} scored under different rules or schema:`)
  for (const p of paths) console.log(`  ${p}`)
  console.log('  They are left as they are. Scoring this config needs a new eval file (plan --eval-file <new path>).')
}

async function cmdDraftCheck(args) {
  const scorerFlag = flagValue(args, 'scorer')
  if (!scorerFlag) usage('MISSING_SCORER', `  pass --scorer ${SCORERS.join('|')}: the scorer the user chose for this draft`)
  if (!isScorer(scorerFlag)) usage(`BAD_SCORER --scorer ${scorerFlag}`, `  --scorer must be one of: ${SCORERS.join(' | ')}`)

  const { draftPath, draft, schema, rules, fingerprint } = await loadDraft(args, scorerFlag)
  const warnings = draftWarnings(draft.properties, draft.scorer)

  console.log(`DRAFT_OK ${draftPath}`)
  console.log(`SCORER ${draft.scorer} · ${plural(schema.length, 'property', 'properties')}`)
  console.log(`RULES ${rules.trim().length} chars for EVAL_RULES.md`)
  console.log('')
  printTable(draft.properties)

  const keys = Object.keys(draft.notes).filter((k) => schema.some((p) => p.key === k))
  if (keys.length) {
    console.log('')
    console.log('NOTES')
    for (const k of keys) console.log(`  ${k}: ${draft.notes[k]}`)
  }

  const all = [
    ...warnings.map((w) => (w.key ? `${w.key}: ${w.message}` : w.message)),
    ...(rules.trim() ? [] : ['The rules text is empty, so the scorer gets no context beyond the properties.']),
    ...draft.warnings
  ]
  console.log('')
  console.log(`WARNINGS ${all.length}`)
  for (const w of all) console.log(`  ${w}`)

  console.log('')
  console.log(`REMOVED_FROM_RULES ${draft.removed.length}`)
  for (const r of draft.removed) console.log(`  ${r}`)

  printEvalFilesUnderOtherCriteria(await evalFilesUnderOtherCriteria(fingerprint))

  console.log('')
  console.log(`FINGERPRINT ${fingerprint}`)
  console.log(`NEXT show the user the table, notes, warnings, and removals. On approval run: node ${enginePath} draft-apply`)
}

/**
 * Stop if any review session in this directory is live. Not only one on a particular eval file, as
 * `plan` checks: a session writes its own config back over EVAL_SCHEMA.json and EVAL_RULES.md when
 * it ends, if the person changed it, which would quietly replace the draft just applied.
 */
async function refuseIfAnyReviewLive(outDir) {
  const record = await readJson(join(outDir, REVIEW_SESSION_FILE))
  if (record?.status !== 'live' || !pidAlive(record.pid)) return
  fail(
    `SESSION_LIVE ${record.workingPath ?? '(unknown eval file)'}`,
    '  A review session (`/qval:review`) is open here, and it writes its own config back to',
    '  EVAL_SCHEMA.json and EVAL_RULES.md when it ends. Ask the user to click FINISH in that tab, then re-run.',
    `  URL ${record.url ?? '(unknown)'}`
  )
}

async function cmdDraftApply(args) {
  const { draft, schema, rules, fingerprint } = await loadDraft(args, null)
  await refuseIfAnyReviewLive(resolve(RUN_DIR))

  const schemaPath = resolve(DEFAULT_SCHEMA_FILE)
  const rulesPath = resolve(DEFAULT_RULES_FILE)
  const verb = (p) => (existsSync(p) ? 'REPLACED' : 'CREATED')
  const schemaVerb = verb(schemaPath)
  const rulesVerb = verb(rulesPath)
  await atomicWriteJson(schemaPath, schemaFile(draft.scorer, schema))
  await atomicWriteText(rulesPath, rules.endsWith('\n') ? rules : `${rules}\n`)

  console.log(`APPLIED scorer ${draft.scorer} · ${plural(schema.length, 'property', 'properties')}`)
  console.log(`${schemaVerb} ${schemaPath}`)
  console.log(`${rulesVerb} ${rulesPath}`)
  printEvalFilesUnderOtherCriteria(await evalFilesUnderOtherCriteria(fingerprint))
  console.log('')
  console.log(`FINGERPRINT ${fingerprint}`)
}

// ── run inputs ────────────────────────────────────────────────────────────────

/** Read + parse a tickets.json, exiting with a specific reason when it isn't usable. */
async function loadTickets(ticketsPath) {
  if (!existsSync(ticketsPath)) fail(`MISSING_TICKETS ${ticketsPath}`)
  const raw = await readJson(ticketsPath)
  if (raw === null) fail(`BAD_JSON ${ticketsPath}`, '  The tickets file is not valid JSON.')
  const parsed = parseTicketsFile(raw)
  if (!parsed) {
    fail(
      `BAD_TICKETS ${ticketsPath}`,
      '  No usable tickets found (expected `{ meta, tickets: [...] }` or an array of tickets,',
      '  each with an integer `id`).'
    )
  }
  return parsed
}

/**
 * The model to stamp on the evaluator: an explicit `--model`, else `$ANTHROPIC_MODEL`. There is no
 * third fallback and no placeholder: an unlabeled run would let two different models score one
 * file without anyone noticing, which is exactly what the per-file model pin exists to prevent.
 * SKILL.md's job is to resolve a value (asking the user if it must) *before* calling `plan`.
 */
function resolveModel(args) {
  const explicit = flagValue(args, 'model')
  if (explicit) return { model: explicit, from: '--model' }
  const env = (process.env.ANTHROPIC_MODEL ?? '').trim()
  if (env) return { model: env, from: '$ANTHROPIC_MODEL' }
  usage(
    'MISSING_MODEL pass --model "<name>": the model that will actually score these tickets.',
    '  It is stamped permanently into the eval file, so there is no default and no placeholder.',
    '  Resolution order: --model, then $ANTHROPIC_MODEL. Ask the user when neither is available.'
  )
}

/**
 * Stop with an error if someone has this eval file open in a review session right now.
 *
 * The review server keeps the eval file in memory for as long as the browser tab is open, which can
 * be hours. If we wrote our scores to that file meanwhile, the next time the person scored a ticket
 * by hand the server would save its own in-memory copy over the top and every score we just wrote
 * would be gone.
 *
 * The server guards against this too, by re-reading the file before each of its own saves. This is
 * the other half: it fails early and says so, before any prompt has been built.
 */
async function refuseIfReviewLive(outDir, evalFilePath) {
  const record = await readJson(join(outDir, REVIEW_SESSION_FILE))
  if (record?.status !== 'live' || !pidAlive(record.pid)) return
  if (!samePath(record.workingPath, evalFilePath)) return
  fail(
    `SESSION_LIVE ${evalFilePath}`,
    '  A review session (`/qval:review`) has this eval file open and is writing to it.',
    '  Ask the user to click FINISH in that tab, then re-run.',
    `  URL ${record.url ?? '(unknown)'}`
  )
}

async function loadContext() {
  const outDir = resolve(RUN_DIR)
  const ctx = await readJson(join(outDir, RUN_CONTEXT_FILE))
  if (!ctx) fail(`NO_CONTEXT ${join(outDir, RUN_CONTEXT_FILE)}`, '  Run `plan` first.')
  return { ctx, outDir }
}

/**
 * Load the run's eval file from disk, refusing only if it has become a *different* evaluation.
 *
 * A review session writes this same file on every human edit, so it very often changes while a
 * round is out with the subagents. That is fine and we take the newer copy: `applyLlmResults`
 * rebuilds only the `llm` evaluator, keyed by ticket id, so a human evaluation made meanwhile
 * survives untouched. Refusing on a mere timestamp change cost a whole round of subagent work to
 * protect something that was never at risk.
 *
 * The two fingerprints are what actually has to hold, and the config half is load-bearing rather
 * than belt-and-braces. `assemble` validates the batch files against the *file's* schema, so
 * adopting a copy whose criteria a review session had re-stamped would score this round against a
 * schema its prompts never described. `Workspace.adoptExternalWrite` guards the other direction
 * with the same comparison.
 */
async function loadRunEvalFile(ctx, restart = '`plan`') {
  const raw = await readJson(ctx.evalFilePath)
  const file = raw ? normalizeEvalFile(raw) : null
  if (!file) fail(`BAD_EVAL_FILE ${ctx.evalFilePath}`, '  Missing, or not a valid .qval.json eval file.')
  if (file.meta.dataset.fingerprint !== ctx.datasetFingerprint) {
    fail(
      `FILE_REPLACED ${ctx.evalFilePath}`,
      '  It is an evaluation of different tickets than the one this run planned.',
      `  Re-run ${restart}. Writing now would mix two datasets into one file.`
    )
  }
  if (file.meta.config.fingerprint !== ctx.configFingerprint) {
    fail(
      `FILE_REPLACED ${ctx.evalFilePath}`,
      '  Its scoring criteria changed since this run was planned (a review session can re-stamp them).',
      `  Re-run ${restart}. These answers were written against the old schema and rules.`
    )
  }
  return file
}

// ── rounds ────────────────────────────────────────────────────────────────────

/**
 * The three kinds of file one Claude run creates: the prompt sent to each subagent, the answer
 * each subagent writes back, and the list of which tickets went into which batch. A Jev run's
 * responses go in `JEV_DIR` instead, which is per-run too.
 *
 * These names are matched exactly rather than by a wildcard, because `/qval:review` keeps its own
 * files in the same directory (`settings.json` and `review-session.json`). Deleting those would
 * lose the user's evaluator name and leave `qval status` with nothing to report.
 */
const RUN_SCRATCH_RE = /^(prompt-\d+-\d+\.txt|batch-\d+-\d+\.json|round-\d+\.json)$/

/**
 * Delete the files left behind by the previous evaluation run.
 *
 * Batch files are numbered, not named after the run that made them, so a run with fewer batches
 * reuses the filenames of a longer one. Scoring 40 tickets writes batch-0-0 through batch-0-3;
 * re-scoring a single ticket later writes only batch-0-0, on top of a file that is already there.
 *
 * If these were left in place and a subagent then failed to write anything, `assemble` would open
 * the leftover file and read the *previous* run's answers as if they were this run's. The ticket
 * numbers inside usually match, so nothing would look wrong: the old scores would be saved with a
 * new timestamp and counted as successes. `assemble` is supposed to record an error when a batch
 * file is missing, and deleting these is what makes that true.
 *
 * Run only after `plan` has finished checking its inputs. A `plan` that stops with an error must
 * leave the directory exactly as it found it, previous run included.
 */
function clearRunScratch(outDir) {
  for (const name of readdirSync(outDir)) {
    if (RUN_SCRATCH_RE.test(name)) rmSync(join(outDir, name), { force: true })
  }
  // The same hazard by ticket id rather than batch number: a response left from an earlier Jev run
  // would be read by `jev --resume` as this run's answer for that ticket.
  rmSync(join(outDir, JEV_DIR), { recursive: true, force: true })
}

/**
 * Compile one prompt file per batch and write the round's manifest. `previous` (retry rounds only)
 * carries the first-attempt results so `assemble` can merge cleaner-wins against them.
 */
function buildRound(ctx, round, targets, rules, schema, previous) {
  const batches = chunk(targets, ctx.batchSize).map((batchTickets, index) => {
    const compiled = compilePrompt({ rules, schema, tickets: batchTickets })
    const promptFile = resolve(join(ctx.outDir, `prompt-${round}-${index}.txt`))
    const batchFile = resolve(join(ctx.outDir, `batch-${round}-${index}.json`))
    // `clearRunScratch` only runs during `plan`, so this covers running `retry --round 1` twice:
    // without it, the second attempt would read the first attempt's answers as its own.
    rmSync(batchFile, { force: true })
    // A subagent has no system slot, so the system prompt is inlined at the top of the file
    // rather than sent separately.
    writeFileSync(promptFile, `${SYSTEM_PROMPT}\n\n${compiled.full}\n`)
    return { index, ticketIds: batchTickets.map((t) => t.id), promptFile, batchFile }
  })
  const manifest = { round, batches, ...(previous ? { previous } : {}) }
  writeJsonSync(join(ctx.outDir, `round-${round}.json`), manifest)
  return manifest
}

function printRound(manifest) {
  console.log(`ROUND ${manifest.round}: ${plural(manifest.batches.length, 'batch', 'batches')} to evaluate.`)
  console.log(
    'Spawn one subagent per line below, all in a single message. Each reads its PROMPT file and writes only the JSON object to its BATCH file:'
  )
  for (const b of manifest.batches) {
    console.log(`  BATCH ${b.index} (${b.ticketIds.length} tickets) PROMPT=${b.promptFile} BATCH=${b.batchFile}`)
  }
}

// ── plan ──────────────────────────────────────────────────────────────────────

/** Resolve the run mode and the tickets it targets. */
function selectTargets(args, tickets, file, ticketsPath) {
  const mode = flagValue(args, 'mode') ?? 'all'
  if (!['all', 'remaining', 'selection'].includes(mode)) {
    usage(`BAD_MODE ${mode}`, '  --mode must be one of: all | remaining | selection')
  }

  if (mode === 'selection') {
    const raw = flagValue(args, 'ids')
    if (!raw) usage('MISSING_IDS', '  --mode selection needs --ids 1,2,3')
    const wanted = new Set()
    for (const part of raw.split(',')) {
      const n = Number(part.trim())
      if (!Number.isInteger(n)) usage(`BAD_IDS "${part.trim()}" is not a ticket id`)
      wanted.add(n)
    }
    const known = new Set(tickets.map((t) => t.id))
    const unknown = [...wanted].filter((id) => !known.has(id))
    if (unknown.length > 0) fail(`UNKNOWN_IDS ${unknown.join(', ')}`, `  Not present in ${ticketsPath}.`)
    return { mode, targets: tickets.filter((t) => wanted.has(t.id)) }
  }

  if (mode === 'remaining') {
    const byId = new Map(ownResults(file ?? { evaluators: [] }, 'llm').map((r) => [r.ticketId, r]))
    return { mode, targets: tickets.filter((t) => needsAttention(byId.get(t.id))) }
  }

  return { mode, targets: tickets }
}

/**
 * Every check a run makes before it writes anything, shared by `plan` (Claude) and `jev` so the two
 * scorers are held to the same guards: the config valid for its scorer and owned by this command,
 * the tickets readable, no live review on the eval file, and an existing eval file of the same
 * dataset, the same config, and the same provider and model. Exits on the first failure, having
 * written nothing.
 * @param {Record<string, unknown>} args
 * @param {{ command: string, scorer: string, provider: string, model: string, from: string, modelHint: string }} run
 */
async function checkRunInputs(args, run) {
  const { rulesPath, schemaPath, rules, scorer, raw } = loadConfig(args)
  const schema = checkRows(raw, schemaPath, scorer)
  if (scorer !== run.scorer) {
    // A file is only ever scored by the scorer its config names, so each command refuses the
    // other's config rather than scoring it the wrong way.
    fail(
      `WRONG_SCORER ${schemaPath}`,
      `  This config is scored by ${scorer}, and \`${run.command}\` only runs the ${run.scorer} scorer.`,
      `  The ${scorer} scorer runs with \`${scorer === 'jev' ? 'jev' : 'plan'}\`.`
    )
  }

  const ticketsFlag = flagValue(args, 'tickets')
  if (!ticketsFlag) usage('MISSING_TICKETS', '  pass --tickets <path to tickets.json>')
  const ticketsPath = resolve(ticketsFlag)
  const { tickets, source } = await loadTickets(ticketsPath)

  const datasetFp = datasetFingerprint(tickets)
  const configFp = configFingerprint(schema, rules, scorer)

  const evalFileFlag = flagValue(args, 'eval-file')
  const evalFilePath = evalFileFlag ? resolve(evalFileFlag) : defaultEvalPath(process.cwd(), ticketsPath)

  const outDir = resolve(RUN_DIR)
  await refuseIfReviewLive(outDir, evalFilePath)

  let file = null
  let adopted = false
  if (existsSync(evalFilePath)) {
    const rawFile = await readJson(evalFilePath)
    file = rawFile ? normalizeEvalFile(rawFile) : null
    if (!file) fail(`BAD_EVAL_FILE ${evalFilePath}`, '  That file is not a valid .qval.json eval file.')
    // Both refusals below carry the same wording as `Workspace.addComparison` (lib/workspace.mjs),
    // so the CLI and the MERGE surface explain an incompatible file the same way.
    if (file.meta.dataset.fingerprint !== datasetFp) {
      fail(
        `DATASET_MISMATCH ${evalFilePath}`,
        '  Different dataset. This eval file is not of the same tickets.',
        `  TICKETS ${ticketsPath}`
      )
    }
    if (file.meta.config.fingerprint !== configFp && !configLocked(file)) {
      // Nothing in the file was scored under its old criteria, so the lock has not engaged and
      // there is nothing for the new criteria to contradict. Refusing here would leave an empty
      // file from an early mistake blocking every run. The restamp is only held in memory: the
      // caller writes it once its own checks have passed (`persistAdoptedConfig`), so a refusal
      // still leaves the file as it was.
      file = adoptConfig(file, { fingerprint: configFp, scorer, schema, rules }, nowIso())
      adopted = true
    } else if (file.meta.config.fingerprint !== configFp) {
      fail(
        `CONFIG_MISMATCH ${evalFilePath}`,
        '  Different rules or schema. This eval file used different scoring criteria.',
        '  Scoring under new criteria needs a new eval file: pass --eval-file <new path>.',
        `  RULES ${rulesPath}`,
        `  SCHEMA ${schemaPath}`
      )
    }
    // One model scores every ticket in a file, and it fires on the same signal the
    // config lock does: a scored `llm` evaluator.
    const locked = lockedLlmProvider(file)
    if (locked && locked.provider !== run.provider) {
      fail(
        `PROVIDER_LOCKED ${evalFilePath}`,
        `  Already scored by ${locked.provider ?? '(unknown)'} · ${locked.model ?? '(unknown)'}, not ${run.provider}.`,
        '  One provider scores every ticket in a file. Start a new eval file with --eval-file <new path> to score it here.'
      )
    }
    if (locked && locked.model !== run.model) {
      fail(
        `MODEL_LOCKED ${evalFilePath}`,
        `  Already scored with ${locked.model ?? '(unknown)'}, but this run would record ${run.model} (from ${run.from}).`,
        run.modelHint.replace('<locked>', locked.model ?? '')
      )
    }
  }

  return {
    rulesPath,
    schemaPath,
    rules,
    scorer,
    schema,
    ticketsPath,
    tickets,
    source,
    datasetFp,
    configFp,
    evalFilePath,
    outDir,
    file,
    adopted
  }
}

/**
 * Write the restamp `checkRunInputs` made in memory, once the run is definitely going ahead. It has
 * to reach disk before any results do: `assemble` validates batch files against the file's own
 * schema, and `loadRunEvalFile` refuses a file whose config fingerprint differs from the run's.
 * @param {{ adopted: boolean, file: object | null, evalFilePath: string }} inputs
 */
async function persistAdoptedConfig(inputs) {
  if (!inputs.adopted || !inputs.file) return
  await atomicWriteJson(inputs.evalFilePath, inputs.file)
}

/**
 * Printed after the command's own first line rather than before it, because the first stdout token
 * is the success signal `SKILL.md` branches on.
 * @param {{ adopted: boolean, evalFilePath: string }} inputs
 */
function printAdoptedConfig(inputs) {
  if (!inputs.adopted) return
  console.log(`CONFIG_ADOPTED ${inputs.evalFilePath}`)
  console.log('  It had no scores yet, so it now uses the current rules and schema.')
}

async function cmdPlan(args) {
  // Everything up to the first write is validation: a refusal must leave the working directory
  // exactly as it found it, with no half-created eval file and no stale round manifest.
  const { model, from } = resolveModel(args)
  const inputs = await checkRunInputs(args, {
    command: 'plan',
    scorer: 'claude',
    provider: CLAUDE_CODE_PROVIDER,
    model,
    from,
    modelHint: '  Re-run with --model "<locked>", or start a new eval file with --eval-file <new path>.'
  })
  const { rulesPath, schemaPath, rules, scorer, schema, ticketsPath, tickets, source, datasetFp, configFp, evalFilePath, outDir } =
    inputs
  let file = inputs.file

  const { mode, targets } = selectTargets(args, tickets, file, ticketsPath)

  const batchSizeFlag = flagValue(args, 'batch-size')
  const batchSize = batchSizeFlag === null ? DEFAULT_BATCH_SIZE : Math.floor(Number(batchSizeFlag))
  if (!Number.isFinite(batchSize) || batchSize < 1) usage(`BAD_BATCH_SIZE ${batchSizeFlag}`, '  --batch-size must be >= 1')

  if (targets.length === 0) {
    console.log(`NOTHING_TO_DO mode=${mode} · no tickets need evaluation`)
    console.log(`EVAL_FILE ${evalFilePath}`)
    return
  }

  mkdirSync(outDir, { recursive: true })
  // Every check above has passed, so this run is definitely going ahead. The previous run's files
  // are now out of date, and leaving them would let this run read them by mistake (see below).
  clearRunScratch(outDir)
  await persistAdoptedConfig(inputs)

  if (!file) {
    file = createWorkingFile({
      appVersion: await pluginVersion(),
      now: nowIso(),
      dataset: { fingerprint: datasetFp, ticketCount: tickets.length, source },
      config: { fingerprint: configFp, scorer, schema, rules }
    })
    await atomicWriteJson(evalFilePath, file)
  }

  const ctx = {
    version: 1,
    plannedAt: nowIso(),
    ticketsPath,
    evalFilePath,
    rulesPath,
    schemaPath,
    outDir,
    provider: CLAUDE_CODE_PROVIDER,
    model,
    modelFrom: from,
    mode,
    batchSize,
    datasetFingerprint: datasetFp,
    configFingerprint: configFp,
    targetIds: targets.map((t) => t.id),
    round: 0,
    assembled: []
  }
  const manifest = buildRound(ctx, 0, targets, rules, schema)
  writeJsonSync(join(outDir, RUN_CONTEXT_FILE), ctx)

  console.log(
    `PLANNED ${plural(targets.length, 'ticket', 'tickets')} · model=${model} (${from}) · mode=${mode} · batchSize=${batchSize}`
  )
  printAdoptedConfig(inputs)
  console.log(`EVAL_FILE ${evalFilePath}`)
  console.log(`OUT ${outDir}`)
  printRound(manifest)
}

// ── assemble ──────────────────────────────────────────────────────────────────

/** Lenient read of a subagent's output: tolerate markdown fences and surrounding prose. */
function parseModelJson(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1))
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* try the next shape */
    }
  }
  return null
}

/** A batch's returned object, or the ticket-level error to record for every ticket it targeted. */
function readBatch(batchFile) {
  let text
  try {
    text = readFileSync(batchFile, 'utf8')
  } catch {
    return { ok: false, error: 'No output was produced for this batch.' }
  }
  const map = parseModelJson(text)
  if (!map) return { ok: false, error: 'Batch output was not a JSON object of ticket results.' }
  return { ok: true, map }
}

async function cmdAssemble(args) {
  const { ctx, outDir } = await loadContext()
  const roundFlag = flagValue(args, 'round')
  const round = roundFlag === null ? 0 : Number(roundFlag)
  if (!Number.isInteger(round) || round < 0) usage(`BAD_ROUND ${roundFlag}`, '  assemble needs --round <n>')

  const manifest = await readJson(join(outDir, `round-${round}.json`))
  if (!manifest) fail(`NO_ROUND round-${round}.json not found in ${outDir}`, '  Run `plan` (or `retry`) first.')

  // `plan` checked this too, but a session can be started while the subagents are out, and this is
  // the command that actually writes the eval file.
  await refuseIfReviewLive(outDir, resolve(ctx.evalFilePath))

  const file = await loadRunEvalFile(ctx)
  // The file's own config snapshot is what the config fingerprint was taken over, so it is the
  // authoritative schema to validate against, not whatever the config files say right now.
  const schema = file.meta.config.schema

  const evaluatedAt = nowIso()
  const results = []
  for (const b of manifest.batches) {
    const batch = readBatch(b.batchFile)
    // Ticket ids come from the round manifest, never from the model: the returned object's keys
    // are only a lookup, so a ticket the model skipped gets an `error` result rather than
    // vanishing from the round.
    for (const id of b.ticketIds) {
      if (!batch.ok) {
        results.push({ ticketId: id, values: {}, evaluatedAt, error: batch.error })
        continue
      }
      const raw = batch.map[String(id)]
      if (raw === undefined) {
        results.push({
          ticketId: id,
          values: {},
          evaluatedAt,
          error: 'Model did not return a result for this ticket.'
        })
        continue
      }
      const { values, issues } = validateValues(raw, schema)
      results.push({ ticketId: id, values, evaluatedAt, error: null, ...(issues.length ? { issues } : {}) })
    }
  }

  // A retry round merges against the snapshot taken before it ran: a value that validated on
  // either attempt wins, so a worse retry never erases a good first-pass value.
  const previous = manifest.previous ?? null
  const merged = previous
    ? results.map((r) => {
        const first = previous[String(r.ticketId)]
        return first ? mergeResults(first, r) : r
      })
    : results

  const next = applyLlmResults(file, { results: merged, provider: ctx.provider, model: ctx.model })
  const written = { ...next, meta: { ...next.meta, updatedAt: nowIso() } }
  await atomicWriteJson(ctx.evalFilePath, written)

  ctx.round = round
  ctx.assembled = [...new Set([...(ctx.assembled ?? []), round])].sort((a, b) => a - b)
  writeJsonSync(join(outDir, RUN_CONTEXT_FILE), ctx)

  const evaluated = merged.filter(isScoredResult).length
  const dropped = merged.reduce((n, r) => n + (r.issues ?? []).filter((i) => i.action === 'dropped').length, 0)
  const failed = merged.filter((r) => r.error).length
  const unresolved = merged.filter((r) => needsAttention(r)).length

  console.log(`ASSEMBLED round ${round} · ${plural(merged.length, 'ticket', 'tickets')}`)
  console.log(`EVALUATED ${evaluated}`)
  console.log(`DROPPED ${dropped}`)
  console.log(`FAILED ${failed}`)
  // Retry is capped at one round, so after round 0 there is nothing left to schedule and what
  // remains is reported as residual rather than as work to do.
  console.log(`NEEDS_RETRY ${round === 0 ? unresolved : 0}`)
  if (round > 0 && unresolved > 0) {
    console.log(`RESIDUAL ${unresolved} (retry is capped at one round; these stay in the file as errors/issues)`)
  }
  console.log(`FILE ${ctx.evalFilePath}`)
}

// ── retry ─────────────────────────────────────────────────────────────────────

async function cmdRetry(args) {
  const { ctx, outDir } = await loadContext()
  const roundFlag = flagValue(args, 'round')
  const round = roundFlag === null ? 1 : Number(roundFlag)
  if (round !== 1) {
    fail(
      `RETRY_CAPPED --round ${roundFlag}`,
      '  A run gets exactly one automatic validation retry (--round 1), by design.',
      '  Residual failures stay in the file as errors/issues; re-plan with --mode remaining to try again.'
    )
  }
  if (!(ctx.assembled ?? []).includes(0)) {
    fail('NOT_ASSEMBLED round 0 has not been assembled', '  Run `assemble --round 0` first.')
  }

  const file = await loadRunEvalFile(ctx)
  const byId = new Map(ownResults(file, 'llm').map((r) => [r.ticketId, r]))
  const targetIds = (ctx.targetIds ?? []).filter((id) => needsAttention(byId.get(id)))
  if (targetIds.length === 0) {
    console.log('NOTHING_TO_RETRY every targeted ticket has a clean result')
    console.log(`FILE ${ctx.evalFilePath}`)
    return
  }

  const { tickets } = await loadTickets(ctx.ticketsPath)
  if (datasetFingerprint(tickets) !== ctx.datasetFingerprint) {
    fail(
      `DATASET_MISMATCH ${ctx.ticketsPath}`,
      '  Different dataset. This eval file is not of the same tickets.',
      '  The tickets file changed since `plan`. Re-run `plan`.'
    )
  }

  // Snapshot the first-pass results before the retry runs, so `assemble --round 1` can merge
  // cleaner-wins against them instead of overwriting the values the first attempt got right.
  const previous = {}
  for (const id of targetIds) {
    const r = byId.get(id)
    if (r) previous[String(id)] = r
  }

  const wanted = new Set(targetIds)
  const targets = tickets.filter((t) => wanted.has(t.id))
  ctx.round = round
  const manifest = buildRound(ctx, round, targets, file.meta.config.rules, file.meta.config.schema, previous)
  writeJsonSync(join(outDir, RUN_CONTEXT_FILE), ctx)

  console.log(`RETRY round ${round} · ${plural(targets.length, 'ticket', 'tickets')} with an error or a dropped value`)
  console.log(`EVAL_FILE ${ctx.evalFilePath}`)
  printRound(manifest)
}

// ── jev ───────────────────────────────────────────────────────────────────────

/** Run `fn` over `items` with at most `limit` in flight. Order of completion is not preserved, so
 *  `fn` gets the index to put its result in place. */
async function mapBounded(items, limit, fn) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * `jev --resume` picks up a run's cached responses, so it is only allowed onto the run that wrote
 * them: the same eval file, the same tickets, the same criteria. Anything else would score this
 * evaluation with answers to different questions.
 */
async function resumeContext(outDir, inputs) {
  const prev = await readJson(join(outDir, RUN_CONTEXT_FILE))
  const same =
    !!prev &&
    prev.provider === TYPESAFE_PROVIDER &&
    samePath(prev.evalFilePath, inputs.evalFilePath) &&
    prev.datasetFingerprint === inputs.datasetFp &&
    prev.configFingerprint === inputs.configFp &&
    Array.isArray(prev.targetIds)
  if (!same || !inputs.file) {
    fail(
      `RESUME_MISMATCH ${inputs.evalFilePath}`,
      '  The last run here was not a Jev run of this eval file, these tickets, and these criteria,',
      '  so its saved responses cannot be used. Run `jev` without --resume to start over.'
    )
  }
  return prev
}

async function cmdJev(args) {
  // Everything up to `clearRunScratch` is validation, exactly as in `plan`: a refusal leaves the
  // directory as it found it, including any responses a `--resume` would need.
  const resume = args.resume === true
  const concurrencyFlag = flagValue(args, 'concurrency')
  const concurrency = concurrencyFlag === null ? DEFAULT_JEV_CONCURRENCY : Math.floor(Number(concurrencyFlag))
  if (!Number.isFinite(concurrency) || concurrency < 1) usage(`BAD_CONCURRENCY ${concurrencyFlag}`, '  --concurrency must be >= 1')

  const inputs = await checkRunInputs(args, {
    command: 'jev',
    scorer: 'jev',
    provider: TYPESAFE_PROVIDER,
    model: JEV_MODEL,
    from: 'the jev scorer',
    modelHint: '  The Jev model is fixed, so score this config into a new eval file with --eval-file <new path>.'
  })
  const { rulesPath, schemaPath, rules, scorer, schema, ticketsPath, tickets, source, datasetFp, configFp, evalFilePath, outDir } =
    inputs

  // Named, never shown. The key reaches this process through the user's shell profile and nothing
  // else, and no output of this command ever carries it.
  const key = apiKeyFromEnv()
  if (!key) {
    fail(
      `MISSING_KEY ${KEY_VARIABLE}`,
      `  Set ${KEY_VARIABLE} in your shell profile (export ${KEY_VARIABLE}=...) and start a new shell.`
    )
  }

  let ctx
  let targets
  if (resume) {
    ctx = await resumeContext(outDir, inputs)
    // Normally a no-op, since the run being resumed already restamped the file. It matters only if
    // the file was put back under its old config since, and `loadRunEvalFile` would refuse that.
    await persistAdoptedConfig(inputs)
    const wanted = new Set(ctx.targetIds)
    targets = tickets.filter((t) => wanted.has(t.id))
  } else {
    const selected = selectTargets(args, tickets, inputs.file, ticketsPath)
    targets = selected.targets
    if (targets.length === 0) {
      console.log(`NOTHING_TO_DO mode=${selected.mode} · no tickets need evaluation`)
      console.log(`EVAL_FILE ${evalFilePath}`)
      return
    }
    mkdirSync(outDir, { recursive: true })
    clearRunScratch(outDir)
    await persistAdoptedConfig(inputs)
    if (!inputs.file) {
      const file = createWorkingFile({
        appVersion: await pluginVersion(),
        now: nowIso(),
        dataset: { fingerprint: datasetFp, ticketCount: tickets.length, source },
        config: { fingerprint: configFp, scorer, schema, rules }
      })
      await atomicWriteJson(evalFilePath, file)
    }
    ctx = {
      version: 1,
      plannedAt: nowIso(),
      ticketsPath,
      evalFilePath,
      rulesPath,
      schemaPath,
      outDir,
      provider: TYPESAFE_PROVIDER,
      model: JEV_MODEL,
      modelFrom: 'the jev scorer',
      mode: selected.mode,
      concurrency,
      datasetFingerprint: datasetFp,
      configFingerprint: configFp,
      targetIds: targets.map((t) => t.id),
      round: 0,
      assembled: []
    }
    writeJsonSync(join(outDir, RUN_CONTEXT_FILE), ctx)
  }

  const jevDir = join(outDir, JEV_DIR)
  mkdirSync(jevDir, { recursive: true })

  /** @type {Array<object | undefined>} one slot per target; a slot left empty was never sent */
  const results = new Array(targets.length)
  let sent = 0
  let cached = 0
  /** Set on a 401 or 403. Every later request would get the same answer, so none is sent. */
  let rejected = null

  await mapBounded(targets, concurrency, async (ticket, i) => {
    const cachePath = join(jevDir, `${ticket.id}.json`)
    let body = resume ? await readJson(cachePath) : null
    if (body !== null) {
      cached++
    } else {
      if (rejected) return
      try {
        const response = await postSystemOne(toJev({ rules, schema, ticket }), { key })
        sent++
        // Written before it is read, so a run that dies mid-way keeps every answer it paid for,
        // and `--resume` reads exactly what this run would have.
        await atomicWriteJson(cachePath, response)
        body = await readJson(cachePath)
      } catch (err) {
        const status = typeof err?.status === 'number' ? err.status : 0
        // TypesafeError messages are redacted already. Anything else is redacted here, since it
        // is printed and stored.
        const message = redactKey(err instanceof Error ? err.message : String(err), key)
        if (status === 401 || status === 403) rejected = rejected ?? message
        results[i] = { ticketId: ticket.id, values: {}, evaluatedAt: nowIso(), error: message }
        return
      }
    }
    results[i] = readJev(body, schema, { ticketId: ticket.id, evaluatedAt: nowIso() })
  })

  // Checked again at the end, since a review session can open on this file during a long run.
  // The responses are cached, so `--resume` after FINISH re-sends nothing.
  await refuseIfReviewLive(outDir, evalFilePath)
  const file = await loadRunEvalFile(ctx, '`jev` without --resume')
  const done = results.filter(Boolean)
  const next = applyLlmResults(file, { results: done, provider: TYPESAFE_PROVIDER, model: JEV_MODEL })
  await atomicWriteJson(evalFilePath, { ...next, meta: { ...next.meta, updatedAt: nowIso() } })

  const evaluated = done.filter(isScoredResult).length
  const dropped = done.reduce((n, r) => n + (r.issues ?? []).filter((x) => x.action === 'dropped').length, 0)
  const failures = done.filter((r) => r.error)
  const unsent = targets.length - done.length
  const reported = [...new Set(done.map((r) => r.reportedModel).filter(Boolean))]

  console.log(`JEV_DONE ${plural(targets.length, 'ticket', 'tickets')} · model=${JEV_MODEL} · mode=${ctx.mode}${resume ? ' · resumed' : ''}`)
  printAdoptedConfig(inputs)
  console.log(`SENT ${sent}`)
  console.log(`CACHED ${cached}`)
  console.log(`EVALUATED ${evaluated}`)
  console.log(`DROPPED ${dropped}`)
  console.log(`FAILED ${failures.length}`)
  const distinct = [...new Map(failures.map((r) => [r.error, r])).values()]
  for (const r of distinct.slice(0, JEV_ERRORS_SHOWN)) console.log(`  #${r.ticketId} ${r.error}`)
  if (distinct.length > JEV_ERRORS_SHOWN) console.log(`  (${distinct.length - JEV_ERRORS_SHOWN} more distinct errors)`)
  if (unsent) console.log(`UNSENT ${unsent}`)
  if (reported.length) console.log(`REPORTED_MODEL ${reported.join(', ')}`)
  console.log(`EVAL_FILE ${evalFilePath}`)

  if (rejected) {
    fail(
      `KEY_REJECTED ${KEY_VARIABLE}`,
      `  Typesafe refused the key, so the remaining ${plural(unsent, 'ticket was', 'tickets were')} not sent.`,
      `  ${rejected}`
    )
  }
}

// ── status ────────────────────────────────────────────────────────────────────

async function cmdStatus(args) {
  const flag = flagValue(args, 'eval-file')
  let evalFilePath = flag ? resolve(flag) : null
  if (!evalFilePath) {
    const outDir = resolve(RUN_DIR)
    const ctx = await readJson(join(outDir, RUN_CONTEXT_FILE))
    evalFilePath = ctx?.evalFilePath ?? null
  }
  if (!evalFilePath) {
    usage('MISSING_EVAL_FILE', `  pass --eval-file <path>, or run where a ${RUN_DIR}/${RUN_CONTEXT_FILE} exists`)
  }

  const raw = await readJson(evalFilePath)
  const file = raw ? normalizeEvalFile(raw) : null
  if (!file) fail(`BAD_EVAL_FILE ${evalFilePath}`, '  Missing, or not a valid .qval.json eval file.')

  // With the fingerprints, which are what say whether a round may be scored onto this file.
  for (const line of summarizeEvalFile(file, evalFilePath, { fingerprints: true })) console.log(line)
}

// ── dispatch ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const cmd = argv[0]
const args = parseArgs(argv.slice(1))

switch (cmd) {
  case 'init':
    cmdInit()
    break
  case 'config':
    await cmdConfig(args)
    break
  case 'draft-check':
    await cmdDraftCheck(args)
    break
  case 'draft-apply':
    await cmdDraftApply(args)
    break
  case 'plan':
    await cmdPlan(args)
    break
  case 'assemble':
    await cmdAssemble(args)
    break
  case 'retry':
    await cmdRetry(args)
    break
  case 'jev':
    await cmdJev(args)
    break
  case 'status':
    await cmdStatus(args)
    break
  default:
    console.error(
      `Usage: node ${basename(enginePath)} <init|config|draft-check|draft-apply|plan|assemble|retry|jev|status> [options]  (see the file header)`
    )
    process.exit(EXIT.USAGE)
}
