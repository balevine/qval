// The in-memory working session: the loaded dataset, the working eval file, and all file I/O for
// it. Every path arrives as an explicit argument, so this carries no dependency on how the host
// asks (native dialog, CLI argument, cwd scan).

import { basename, dirname, extname, join } from 'node:path'
import { parseTicketsFile } from './tickets.mjs'
import { applyHumanValues, configLocked, createWorkingFile, looksLikeEvalFile, normalizeEvalFile } from './evalFile.mjs'
import { aggregateSession } from './aggregate.mjs'
import { configFingerprint, datasetFingerprint } from './fingerprint.mjs'
import { atomicWriteJson, readJson } from './fsUtil.mjs'

/**
 * @typedef {import('@shared/types').ComparisonCandidate} ComparisonCandidate
 * @typedef {import('@shared/types').ComparisonFile} ComparisonFile
 * @typedef {import('@shared/types').EvalFile} EvalFile
 * @typedef {import('@shared/types').EvalValues} EvalValues
 * @typedef {import('@shared/types').SessionSnapshot} SessionSnapshot
 * @typedef {import('@shared/types').Ticket} Ticket
 * @typedef {import('./settingsStore.mjs').SettingsStore} SettingsStore
 */

/**
 * Last-resort source of tickets paths, used when an eval file's dataset can't be found from what we
 * already know. The caller decides how to ask (a cwd scan, under the CLI). Resolves to a path, to a
 * list of candidates to try in order, or to null when there's no answer.
 *
 * A list is safe because the fingerprint, not the caller, decides which one it is — so a host that
 * cannot narrow the directory down to one file should hand over all of them rather than give up.
 * @typedef {() => Promise<string | string[] | null>} DatasetLocator
 */

/**
 * A file the host is willing to merge, before anyone has asked for it. The host resolves these (the
 * CLI scans the working directory and takes `--compare` arguments); the UI only ever sees the `id`
 * and the `name`, which is what keeps paths off the wire (spec §19).
 * @typedef {{ id: string, name: string, path: string }} ComparisonSource
 */

/**
 * Where `exportReport` writes, derived from the working file rather than chosen: `tickets.qval.json`
 * → `tickets.report.json`, alongside it. The browser names no destination.
 * @param {string} workingPath
 * @returns {string}
 */
export function reportPathFor(workingPath) {
  const stem = basename(workingPath, extname(workingPath)).replace(/\.qval$/, '')
  return join(dirname(workingPath), `${stem}.report.json`)
}

/**
 * Suggest a `<dataset>.qval.json` filename from the backing tickets path.
 * @param {string | null} datasetPath
 * @returns {string}
 */
export function suggestEvalName(datasetPath) {
  if (!datasetPath) return 'evaluation.qval.json'
  const stem = basename(datasetPath, extname(datasetPath)).replace(/\.qval$/, '')
  return `${stem}.qval.json`
}

/**
 * Owns the in-memory working session (dataset tickets + working eval file + its path) and all file
 * I/O for it. The renderer holds a display copy but never a filesystem path — the host tracks the
 * path and does atomic writes (spec §10/§11).
 */
export class Workspace {
  /**
   * @param {SettingsStore} settings
   * @param {string} appVersion
   * @param {() => string} [now]
   */
  constructor(settings, appVersion, now = () => new Date().toISOString()) {
    this.settings = settings
    this.appVersion = appVersion
    this.now = now
    /** @type {Ticket[]} */
    this.tickets = []
    this.datasetFp = ''
    /** @type {EvalFile | null} */
    this.workingFile = null
    /** @type {string | null} */
    this.workingPath = null
    /** Read-only comparison files added via MERGE (cleared when the dataset/working file changes). */
    /** @type {ComparisonFile[]} */
    this.comparisons = []
    /** Files the host offers for merging, whether merged yet or not. */
    /** @type {ComparisonSource[]} */
    this.sources = []
    /** Serializes human edits so rapid changes can't read-merge-write out of order (as in SettingsStore). */
    this.editQueue = Promise.resolve()
  }

  /** @returns {SessionSnapshot | null} */
  snapshot() {
    if (!this.workingFile) return null
    return {
      tickets: this.tickets,
      workingFile: this.workingFile,
      workingPath: this.workingPath,
      comparisons: this.comparisons,
      candidates: this.comparisonCandidates()
    }
  }

  /**
   * Offer a set of mergeable files. Replaces any previous offer; merged comparisons are untouched,
   * so a candidate list that no longer names an already-merged file does not un-merge it.
   * @param {ComparisonSource[]} sources
   * @returns {void}
   */
  setComparisonSources(sources) {
    this.sources = sources
  }

  /**
   * The offer as the UI sees it: id and name only, plus whether it is currently merged.
   * @returns {ComparisonCandidate[]}
   */
  comparisonCandidates() {
    return this.sources.map((s) => ({
      id: s.id,
      name: s.name,
      merged: this.comparisons.some((c) => c.id === s.id)
    }))
  }

  /**
   * MERGE one of the offered candidates, by id. This is the only merge route the browser has: the
   * path never leaves the host (spec §19).
   * @param {string} id
   * @returns {Promise<SessionSnapshot | null>}
   */
  async mergeComparison(id) {
    const source = this.sources.find((s) => s.id === id)
    if (!source) throw new Error('That file is no longer available to merge.')
    return this.addComparison(source.path, source.id, source.name)
  }

  /** @returns {EvalFile | null} */
  currentWorkingFile() {
    return this.workingFile
  }

  /**
   * Path the working file is bound to, or null when it has never been saved.
   * @returns {string | null}
   */
  currentPath() {
    return this.workingPath
  }

  /**
   * Replace the in-memory working file (bumping `updatedAt`) and, if it has a path, persist it
   * atomically. Used by the evaluation service to write results incrementally.
   * @param {EvalFile} file
   * @returns {Promise<void>}
   */
  async commitWorkingFile(file) {
    this.workingFile = { ...file, meta: { ...file.meta, updatedAt: this.now() } }
    if (this.workingPath) await atomicWriteJson(this.workingPath, this.workingFile)
  }

  /**
   * While the working file is **unlocked** (no scored values yet), keep its config snapshot in sync
   * with the current working schema/rules so the file's fingerprint stays honest as the user sets up
   * the schema. Once a score locks the file, its config is frozen and this is a no-op (spec §3/§4).
   * @returns {Promise<void>}
   */
  async ensureConfigStamped() {
    if (!this.workingFile || configLocked(this.workingFile)) return
    const s = await this.settings.get()
    const fingerprint = await configFingerprint(s.schema, s.rules)
    if (this.workingFile.meta.config.fingerprint === fingerprint) return
    await this.commitWorkingFile({
      ...this.workingFile,
      meta: { ...this.workingFile.meta, config: { fingerprint, schema: s.schema, rules: s.rules } }
    })
  }

  /**
   * The loaded file is the authoritative config source: reload the working schema/rules from its
   * snapshot so the editors mirror the file (and, once locked, stay pinned to it). Called on
   * open/reload (spec §3). The model that produced the file is not settings — it lives on the file's
   * own `llm` evaluator, which is what pins a top-up run (`lockedLlmProvider`).
   * @param {EvalFile} file
   * @returns {Promise<void>}
   */
  async hydrateSettingsFromFile(file) {
    await this.settings.set({ schema: file.meta.config.schema, rules: file.meta.config.rules })
  }

  /**
   * Upsert a ticket's human values into the working file and persist. **Serialized** so rapid
   * edits apply in call order without clobbering each other (spec §7).
   * @param {{ name: string, ticketId: number, values: EvalValues }} args
   * @returns {Promise<void>}
   */
  async applyHumanEdit(args) {
    const run = async () => {
      if (!this.workingFile) return
      // Pin the file's config to the schema being scored against before the first value locks it.
      await this.ensureConfigStamped()
      const next = applyHumanValues(this.workingFile, { ...args, now: this.now() })
      await this.commitWorkingFile(next)
    }
    const result = this.editQueue.then(run, run)
    this.editQueue = result.catch(() => undefined)
    return result
  }

  /**
   * OPEN `path`, auto-detecting a tickets.json (→ new working file) vs a *.qval.json (→ load it,
   * relinking its dataset). `locate` supplies the tickets path if the eval file's dataset can't be
   * found from what we already know.
   * @param {string} path
   * @param {DatasetLocator} [locate]
   * @returns {Promise<SessionSnapshot>}
   */
  async open(path, locate) {
    const raw = await readJson(path)
    if (raw == null) throw new Error('That file could not be read as JSON.')

    if (looksLikeEvalFile(raw)) return this.openEvalFile(raw, path, locate)

    const parsed = parseTicketsFile(raw)
    if (!parsed) throw new Error('That file is neither a tickets.json nor a .qval.json eval file.')
    return this.importDataset(parsed.tickets, parsed.source, path)
  }

  /**
   * Build a fresh working file from imported tickets + the current schema/rules snapshot.
   * @param {Ticket[]} tickets
   * @param {{ provider?: string, model?: string } | null} source
   * @param {string} datasetPath
   * @returns {Promise<SessionSnapshot>}
   */
  async importDataset(tickets, source, datasetPath) {
    const s = await this.settings.get()
    const [fp, cfp] = await Promise.all([
      datasetFingerprint(tickets),
      configFingerprint(s.schema, s.rules)
    ])
    this.tickets = tickets
    this.datasetFp = fp
    this.workingFile = createWorkingFile({
      appVersion: this.appVersion,
      now: this.now(),
      dataset: { fingerprint: fp, ticketCount: tickets.length, source },
      config: { fingerprint: cfp, schema: s.schema, rules: s.rules }
    })
    this.workingPath = null
    this.comparisons = []
    await this.settings.set({ lastDatasetPath: datasetPath })
    return /** @type {SessionSnapshot} */ (this.snapshot())
  }

  /**
   * Load a working eval file, relinking its dataset by fingerprint.
   * @param {unknown} raw
   * @param {string} path
   * @param {DatasetLocator} [locate]
   * @returns {Promise<SessionSnapshot>}
   */
  async openEvalFile(raw, path, locate) {
    const file = normalizeEvalFile(raw)
    if (!file) throw new Error('That .qval.json file is invalid.')
    const tickets = await this.locateDataset(file.meta.dataset.fingerprint, locate)
    if (!tickets) throw new Error('Could not find the tickets.json this eval file was built from.')
    this.tickets = tickets
    this.datasetFp = file.meta.dataset.fingerprint
    this.workingFile = file
    this.workingPath = path
    this.comparisons = []
    await this.hydrateSettingsFromFile(file)
    return /** @type {SessionSnapshot} */ (this.snapshot())
  }

  /**
   * Find tickets matching `fingerprint`: already-loaded → lastDatasetPath → ask `locate`.
   * @param {string} fingerprint
   * @param {DatasetLocator} [locate]
   * @returns {Promise<Ticket[] | null>}
   */
  async locateDataset(fingerprint, locate) {
    if (this.datasetFp === fingerprint && this.tickets.length) return this.tickets

    const s = await this.settings.get()
    if (s.lastDatasetPath) {
      const t = await this.tryLoadTickets(s.lastDatasetPath, fingerprint)
      if (t) return t
    }

    const located = locate ? await locate() : null
    const candidates = located == null ? [] : Array.isArray(located) ? located : [located]
    if (candidates.length === 0) return null
    for (const p of candidates) {
      const t = await this.tryLoadTickets(p, fingerprint)
      if (!t) continue
      await this.settings.set({ lastDatasetPath: p })
      return t
    }
    // Something was offered and none of it was this dataset, which is a different answer from
    // "nothing was offered" and gets a different message upstream.
    throw new Error('Those tickets do not match this eval file (different dataset).')
  }

  /**
   * Read a tickets file and return its tickets only if the fingerprint matches.
   * @param {string} path
   * @param {string} fingerprint
   * @returns {Promise<Ticket[] | null>}
   */
  async tryLoadTickets(path, fingerprint) {
    const raw = await readJson(path)
    const parsed = raw ? parseTicketsFile(raw) : null
    if (!parsed) return null
    const fp = await datasetFingerprint(parsed.tickets)
    return fp === fingerprint ? parsed.tickets : null
  }

  /**
   * Save the working file to `to`, or to the path it's already bound to. Returns the path, or null
   * when there's nothing to save and nowhere to save it. The host binds a path before the browser
   * exists, so in practice `to` is only passed for the very first write of a new working file.
   * @param {string} [to]
   * @returns {Promise<string | null>}
   */
  async save(to) {
    if (!this.workingFile) return null
    const path = to || this.workingPath
    if (!path) return null
    this.workingFile = { ...this.workingFile, meta: { ...this.workingFile.meta, updatedAt: this.now() } }
    await atomicWriteJson(path, this.workingFile)
    this.workingPath = path
    return path
  }

  /**
   * MERGE the *.qval.json at `path`, gating on matching fingerprints, and pool its evaluators. The
   * id defaults to the path, which is why `mergeComparison` exists: the browser is only ever given
   * candidate ids, and the host is the only thing that knows what they point at.
   * @param {string} path
   * @param {string} [id]
   * @param {string} [name]
   * @returns {Promise<SessionSnapshot | null>}
   */
  async addComparison(path, id = path, name = basename(path)) {
    if (!this.workingFile) return null
    if (this.comparisons.some((c) => c.id === id)) throw new Error('That file is already merged.')

    const file = normalizeEvalFile(await readJson(path))
    if (!file) throw new Error('That file is not a valid .qval.json eval file.')
    if (file.meta.dataset.fingerprint !== this.workingFile.meta.dataset.fingerprint) {
      throw new Error('Different dataset. This eval file is not of the same tickets.')
    }
    if (file.meta.config.fingerprint !== this.workingFile.meta.config.fingerprint) {
      throw new Error('Different rules or schema. This eval file used different scoring criteria.')
    }
    this.comparisons = [...this.comparisons, { id, name, evaluators: file.evaluators }]
    return this.snapshot()
  }

  /**
   * @param {string} id
   * @returns {SessionSnapshot | null}
   */
  removeComparison(id) {
    this.comparisons = this.comparisons.filter((c) => c.id !== id)
    return this.snapshot()
  }

  /**
   * Write a flat merged aggregate report (per ticket + dataset roll-up) to `path`.
   * @param {string} path
   * @returns {Promise<string | null>}
   */
  async exportReport(path) {
    if (!this.workingFile) return null

    const ids = this.tickets.map((t) => t.id)
    const { byTicket, rollup } = aggregateSession(this.workingFile, this.comparisons, ids)
    const subjectById = new Map(this.tickets.map((t) => [t.id, t.subject]))
    const report = {
      meta: {
        app: 'qval-report',
        generatedAt: this.now(),
        dataset: this.workingFile.meta.dataset,
        config: this.workingFile.meta.config,
        evaluators: [this.workingFile, ...this.comparisons.map((c) => ({ evaluators: c.evaluators }))]
          .flatMap((f) => f.evaluators.map((e) => ({ kind: e.kind, name: e.name })))
      },
      rollup,
      tickets: this.tickets.map((t) => ({ subject: subjectById.get(t.id), ...byTicket[t.id] }))
    }
    await atomicWriteJson(path, report)
    return path
  }
}
