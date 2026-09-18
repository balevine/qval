#!/usr/bin/env node
// Deterministic engine for the evaluate-tickets skill. Owns everything the LLM must NOT: config
// validation, both fingerprints, target selection, batching, prompt compilation, per-value
// validation and repair, retry accounting, eval-file assembly, and atomic writes. The only thing
// left to the ambient Claude subagents is judgment (see SKILL.md).
//
// Subcommands:
//   init                  copy the missing starter files (EVAL_RULES.md, EVAL_SCHEMA.json) into
//                         the current directory. Exits 3 when it created one, meaning "stop here
//                         and let the user edit them".
//   config [--check]      validate the config and print the property table + config fingerprint
//          [--write]      rewrite EVAL_SCHEMA.json in normalized form (after a passing check)
//          [--preview]    print the compiled static prefix the model will read
//          [--rules <file>] [--schema <file>]
//   plan     --tickets <file> --model "<name>" [--eval-file <file>] [--rules <file>]
//            [--schema <file>] [--out .qval-run] [--mode all|remaining|selection --ids 1,2,3]
//            [--batch-size 10]
//   assemble [--out .qval-run] --round <r>
//   retry    [--out .qval-run] --round 1
//   status   [--eval-file <file>] [--out .qval-run]
//
// Run state lives in <out>/run-context.json; each round's manifest in <out>/round-<r>.json; each
// batch's compiled prompt in <out>/prompt-<r>-<i>.txt and the subagent's raw output in
// <out>/batch-<r>-<i>.json. The durable artifact is the eval file, written outside <out>.
//
// stdout is deliberately a short summary: the engine reads batch files in Node, so ticket content
// and scored values never round-trip through Claude's context.
//
// Exit codes are control flow for the skill: 0 ok, 1 usage, 2 unusable input (missing file, bad
// JSON, invalid schema, fingerprint or model mismatch), 3 scaffolded (stop and let the user edit).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseArgs } from '../../lib/args.mjs'
import { atomicWriteJson, readJson } from '../../lib/fsUtil.mjs'
import { normalizeSchema, propertyErrors } from '../../lib/schema.mjs'
import { normalizeRules } from '../../lib/rules.mjs'
import { configFingerprint, datasetFingerprint } from '../../lib/fingerprint.mjs'
import { compilePrompt, SYSTEM_PROMPT } from '../../lib/promptCompiler.mjs'
import { parseTicketsFile } from '../../lib/tickets.mjs'
import { validateValues } from '../../lib/evalValidate.mjs'
import { DEFAULT_BATCH_SIZE } from '../../lib/evaluation.mjs'
import {
  applyLlmResults,
  createWorkingFile,
  isScoredResult,
  lockedLlmProvider,
  mergeResults,
  needsAttention,
  normalizeEvalFile,
  ownResults
} from '../../lib/evalFile.mjs'

const EXIT = { OK: 0, USAGE: 1, INPUT: 2, SCAFFOLDED: 3 }

const PROPERTY_TYPES = ['score', 'boolean', 'enum', 'text']
const DEFAULT_RULES_FILE = 'EVAL_RULES.md'
const DEFAULT_SCHEMA_FILE = 'EVAL_SCHEMA.json'
const DEFAULT_OUT_DIR = '.qval-run'
const RUN_CONTEXT_FILE = 'run-context.json'
/** Recorded on the evaluator: what produced these scores (spec §5). */
const PROVIDER = 'claude-code'
/** Cosmetic `meta.appVersion`. The skill folder is copyable, so it can't read the repo's package.json. */
const APP_VERSION = '0.2.0'

const templatePath = (name) => fileURLToPath(new URL(`./templates/${name}`, import.meta.url))
const enginePath = fileURLToPath(import.meta.url)

const nowIso = () => new Date().toISOString()
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

/** A `--flag value` string, or null when the flag is absent, bare, or blank. */
function flagValue(args, name) {
  const v = args[name]
  if (v === undefined || v === true) return null
  const s = String(v).trim()
  return s.length > 0 ? s : null
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
 * Row-level validation for a hand-authored schema file. `propertyErrors` is the schema editor's
 * check and assumes the row already has a known type, so the type guard is added here. A row
 * typed `"rating"` passes `propertyErrors` but `normalizeSchema` silently drops it.
 */
function rowErrors(raw, otherKeys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['Property must be a JSON object.']
  const errors = []
  if (!PROPERTY_TYPES.includes(raw.type)) errors.push(`Type must be one of: ${PROPERTY_TYPES.join(' | ')}.`)
  // `propertyErrors` reads `.label`/`.key` as strings; a raw file may hold anything.
  const row = { ...raw, label: String(raw.label ?? ''), key: String(raw.key ?? '') }
  errors.push(...propertyErrors(row, otherKeys))
  return errors
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
  if (!Array.isArray(raw)) fail(`BAD_SCHEMA ${schemaPath}`, '  The schema file must be a JSON array of properties.')
  if (raw.length === 0) fail(`SCHEMA_EMPTY ${schemaPath}`, '  Add at least one property to evaluate.')

  return { rulesPath, schemaPath, rules, raw }
}

const typeLabel = (row) => `${row && typeof row === 'object' ? (row.type ?? '?') : '?'}${row?.multiple === true ? '[]' : ''}`

/** The right-hand column: the bounds of a score, the options of an enum. */
function detailOf(row) {
  if (!row || typeof row !== 'object') return '-'
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
 * Validate every row and report per-row problems. Exits non-zero on any error so the skill stops
 * rather than planning a run against a schema the model can't satisfy.
 */
function checkRows(raw, schemaPath) {
  const keys = raw.map((row) => String(row?.key ?? '').trim())
  const failures = []
  raw.forEach((row, i) => {
    const others = keys.filter((_, j) => j !== i).filter(Boolean)
    for (const message of rowErrors(row, others)) failures.push({ index: i, row, message })
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
  const schema = normalizeSchema(raw)
  if (schema.length !== raw.length) {
    fail(
      `SCHEMA_INVALID normalization dropped ${raw.length - schema.length} of ${raw.length} properties`,
      `FILE ${schemaPath}`
    )
  }
  return schema
}

// ── init ──────────────────────────────────────────────────────────────────────

function cmdInit() {
  let created = 0
  for (const name of [DEFAULT_RULES_FILE, DEFAULT_SCHEMA_FILE]) {
    const dest = resolve(name)
    if (existsSync(dest)) {
      console.log(`EXISTS ${dest}`)
      continue
    }
    copyFileSync(templatePath(name), dest)
    console.log(`CREATED ${dest}`)
    created++
  }
  if (created === 0) {
    console.log('READY both config files are already present')
    return
  }
  console.log(`NEXT edit the file(s) above, then run: node ${enginePath} config --check`)
  // Non-zero on purpose: the starter config is a placeholder, not a config anybody meant to run.
  process.exit(EXIT.SCAFFOLDED)
}

// ── config ────────────────────────────────────────────────────────────────────

async function cmdConfig(args) {
  const { rulesPath, schemaPath, rules, raw } = loadConfig(args)

  console.log(`RULES ${rulesPath} · ${rules.trim().length} chars`)
  console.log(`SCHEMA ${schemaPath} · ${raw.length} propert${raw.length === 1 ? 'y' : 'ies'}`)
  console.log('')
  printTable(raw)

  const schema = checkRows(raw, schemaPath)
  const fingerprint = configFingerprint(schema, rules)

  if (args.preview) {
    const { staticPrefix } = compilePrompt({ rules, schema, tickets: [] })
    console.log('')
    console.log(`PREVIEW static prefix (rules + schema spec + output contract) · ${staticPrefix.length} chars`)
    console.log('-'.repeat(78))
    console.log(staticPrefix)
    console.log('-'.repeat(78))
  }

  if (args.write) {
    const next = JSON.stringify(schema, null, 2)
    const current = readFileSync(schemaPath, 'utf8')
    if (current.trim() === next.trim()) {
      console.log('')
      console.log(`UNCHANGED ${schemaPath} is already normalized`)
    } else {
      await atomicWriteJson(schemaPath, schema)
      console.log('')
      console.log(`WROTE ${schemaPath} · ${schema.length} propert${schema.length === 1 ? 'y' : 'ies'}`)
    }
  }

  console.log('')
  console.log(`CONFIG OK · ${schema.length} propert${schema.length === 1 ? 'y' : 'ies'}`)
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

/** `<dataset stem>.qval.json` in the working directory (mirrors `suggestEvalName` in lib/workspace.mjs,
 *  which the CLI uses. The engine stays free of that import so it pulls in nothing it does not need). */
function defaultEvalPath(ticketsPath) {
  const stem = basename(ticketsPath, extname(ticketsPath)).replace(/\.qval$/, '')
  return resolve(`${stem}.qval.json`)
}

async function loadContext(args) {
  const outDir = resolve(flagValue(args, 'out') ?? DEFAULT_OUT_DIR)
  const ctx = await readJson(join(outDir, RUN_CONTEXT_FILE))
  if (!ctx) fail(`NO_CONTEXT ${join(outDir, RUN_CONTEXT_FILE)}`, '  Run `plan` first.')
  return { ctx, outDir }
}

/**
 * Load the run's eval file and refuse if it changed on disk since `plan` recorded its `updatedAt`.
 * A review session writes the same file on every human edit, so without this guard an `assemble`
 * could overwrite a human evaluation made while the run was out with the subagents.
 */
async function loadRunEvalFile(ctx) {
  const raw = await readJson(ctx.evalFilePath)
  const file = raw ? normalizeEvalFile(raw) : null
  if (!file) fail(`BAD_EVAL_FILE ${ctx.evalFilePath}`, '  Missing, or not a valid .qval.json eval file.')
  if (file.meta.updatedAt !== ctx.evalUpdatedAt) {
    fail(
      `STALE_FILE ${ctx.evalFilePath}`,
      '  It changed on disk since this run was planned (a review session may have it open).',
      '  Close that tab and re-run `plan`. Writing now would overwrite those edits.'
    )
  }
  return file
}

// ── rounds ────────────────────────────────────────────────────────────────────

/**
 * Compile one prompt file per batch and write the round's manifest. `previous` (retry rounds only)
 * carries the first-attempt results so `assemble` can merge cleaner-wins against them.
 */
function buildRound(ctx, round, targets, rules, schema, previous) {
  const batches = chunk(targets, ctx.batchSize).map((batchTickets, index) => {
    const compiled = compilePrompt({ rules, schema, tickets: batchTickets })
    const promptFile = resolve(join(ctx.outDir, `prompt-${round}-${index}.txt`))
    const batchFile = resolve(join(ctx.outDir, `batch-${round}-${index}.json`))
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

async function cmdPlan(args) {
  // Everything up to the first write is validation: a refusal must leave the working directory
  // exactly as it found it, with no half-created eval file and no stale round manifest.
  const { model, from } = resolveModel(args)

  const { rulesPath, schemaPath, rules, raw } = loadConfig(args)
  const schema = checkRows(raw, schemaPath)

  const ticketsFlag = flagValue(args, 'tickets')
  if (!ticketsFlag) usage('MISSING_TICKETS', '  pass --tickets <path to tickets.json>')
  const ticketsPath = resolve(ticketsFlag)
  const { tickets, source } = await loadTickets(ticketsPath)

  const datasetFp = datasetFingerprint(tickets)
  const configFp = configFingerprint(schema, rules)

  const evalFileFlag = flagValue(args, 'eval-file')
  const evalFilePath = evalFileFlag ? resolve(evalFileFlag) : defaultEvalPath(ticketsPath)

  let file = null
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
    if (file.meta.config.fingerprint !== configFp) {
      fail(
        `CONFIG_MISMATCH ${evalFilePath}`,
        '  Different rules or schema. This eval file used different scoring criteria.',
        '  Scoring under new criteria needs a new eval file: pass --eval-file <new path>.',
        `  RULES ${rulesPath}`,
        `  SCHEMA ${schemaPath}`
      )
    }
    // One model scores every ticket in a file (spec §3/§4), and it fires on the same signal the
    // config lock does: a scored `llm` evaluator.
    const locked = lockedLlmProvider(file)
    if (locked && locked.provider !== PROVIDER) {
      fail(
        `PROVIDER_LOCKED ${evalFilePath}`,
        `  Already scored by ${locked.provider ?? '(unknown)'} · ${locked.model ?? '(unknown)'}, not this skill.`,
        '  A desktop release wrote it. Start a new eval file with --eval-file <new path> to score it here.'
      )
    }
    if (locked && locked.model !== model) {
      fail(
        `MODEL_LOCKED ${evalFilePath}`,
        `  Already scored with ${locked.model ?? '(unknown)'}, but this run would record ${model} (from ${from}).`,
        `  Re-run with --model "${locked.model ?? ''}", or start a new eval file with --eval-file <new path>.`
      )
    }
  }

  const { mode, targets } = selectTargets(args, tickets, file, ticketsPath)

  const batchSizeFlag = flagValue(args, 'batch-size')
  const batchSize = batchSizeFlag === null ? DEFAULT_BATCH_SIZE : Math.floor(Number(batchSizeFlag))
  if (!Number.isFinite(batchSize) || batchSize < 1) usage(`BAD_BATCH_SIZE ${batchSizeFlag}`, '  --batch-size must be >= 1')

  if (targets.length === 0) {
    console.log(`NOTHING_TO_DO mode=${mode} · no tickets need evaluation`)
    console.log(`EVAL_FILE ${evalFilePath}`)
    return
  }

  const outDir = resolve(flagValue(args, 'out') ?? DEFAULT_OUT_DIR)
  mkdirSync(outDir, { recursive: true })

  if (!file) {
    file = createWorkingFile({
      appVersion: APP_VERSION,
      now: nowIso(),
      dataset: { fingerprint: datasetFp, ticketCount: tickets.length, source },
      config: { fingerprint: configFp, schema, rules }
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
    provider: PROVIDER,
    model,
    modelFrom: from,
    mode,
    batchSize,
    datasetFingerprint: datasetFp,
    configFingerprint: configFp,
    // Stale-file guard, re-stamped on every write we make ourselves.
    evalUpdatedAt: file.meta.updatedAt,
    targetIds: targets.map((t) => t.id),
    round: 0,
    assembled: []
  }
  const manifest = buildRound(ctx, 0, targets, rules, schema)
  writeJsonSync(join(outDir, RUN_CONTEXT_FILE), ctx)

  console.log(
    `PLANNED ${plural(targets.length, 'ticket', 'tickets')} · model=${model} (${from}) · mode=${mode} · batchSize=${batchSize}`
  )
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
  const { ctx, outDir } = await loadContext(args)
  const roundFlag = flagValue(args, 'round')
  const round = roundFlag === null ? 0 : Number(roundFlag)
  if (!Number.isInteger(round) || round < 0) usage(`BAD_ROUND ${roundFlag}`, '  assemble needs --round <n>')

  const manifest = await readJson(join(outDir, `round-${round}.json`))
  if (!manifest) fail(`NO_ROUND round-${round}.json not found in ${outDir}`, '  Run `plan` (or `retry`) first.')

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
  // either attempt wins, so a worse retry never erases a good first-pass value (spec §6).
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

  ctx.evalUpdatedAt = written.meta.updatedAt
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
  const { ctx, outDir } = await loadContext(args)
  const roundFlag = flagValue(args, 'round')
  const round = roundFlag === null ? 1 : Number(roundFlag)
  if (round !== 1) {
    fail(
      `RETRY_CAPPED --round ${roundFlag}`,
      '  A run gets exactly one automatic validation retry (--round 1), by design (spec §6).',
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

// ── status ────────────────────────────────────────────────────────────────────

async function cmdStatus(args) {
  const flag = flagValue(args, 'eval-file')
  let evalFilePath = flag ? resolve(flag) : null
  if (!evalFilePath) {
    const outDir = resolve(flagValue(args, 'out') ?? DEFAULT_OUT_DIR)
    const ctx = await readJson(join(outDir, RUN_CONTEXT_FILE))
    evalFilePath = ctx?.evalFilePath ?? null
  }
  if (!evalFilePath) {
    usage('MISSING_EVAL_FILE', `  pass --eval-file <path>, or run where a ${DEFAULT_OUT_DIR}/${RUN_CONTEXT_FILE} exists`)
  }

  const raw = await readJson(evalFilePath)
  const file = raw ? normalizeEvalFile(raw) : null
  if (!file) fail(`BAD_EVAL_FILE ${evalFilePath}`, '  Missing, or not a valid .qval.json eval file.')

  const total = file.meta.dataset.ticketCount
  const llmResults = ownResults(file, 'llm')
  const humanResults = ownResults(file, 'human')
  const llm = file.evaluators.find((e) => e.kind === 'llm')
  const errors = llmResults.filter((r) => r.error).length
  const drops = llmResults.reduce((n, r) => n + (r.issues ?? []).filter((i) => i.action === 'dropped').length, 0)

  console.log(`FILE ${evalFilePath}`)
  console.log(`DATASET ${file.meta.dataset.fingerprint} · ${plural(total, 'ticket', 'tickets')}`)
  console.log(`CONFIG ${file.meta.config.fingerprint} · ${plural(file.meta.config.schema.length, 'property', 'properties')}`)
  console.log(
    `LLM ${llm ? `${llm.provider ?? '(no provider)'} · ${llm.model ?? '(no model)'}` : '(none)'} · scored ${llmResults.filter(isScoredResult).length}/${total} · errors ${errors} · dropped-values ${drops}`
  )
  console.log(`HUMAN scored ${humanResults.filter(isScoredResult).length}/${total}`)
  console.log(`UPDATED ${file.meta.updatedAt}`)
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
  case 'plan':
    await cmdPlan(args)
    break
  case 'assemble':
    await cmdAssemble(args)
    break
  case 'retry':
    await cmdRetry(args)
    break
  case 'status':
    await cmdStatus(args)
    break
  default:
    console.error(
      `Usage: node ${basename(enginePath)} <init|config|plan|assemble|retry|status> [options]  (see the file header)`
    )
    process.exit(EXIT.USAGE)
}
