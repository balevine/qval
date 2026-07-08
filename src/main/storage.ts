import { basename, extname, join } from 'path'
import type { EvalFile, SessionSnapshot, Settings, Ticket } from '@shared/types'
import { parseTicketsFile } from '@shared/validate'
import {
  applyHumanValues,
  configLocked,
  createWorkingFile,
  looksLikeEvalFile,
  normalizeEvalFile
} from '@shared/evalFile'
import { aggregateSession } from '@shared/aggregate'
import type { ComparisonFile, EvalValues } from '@shared/types'
import { configFingerprint, datasetFingerprint } from '@shared/fingerprint'
import { atomicWriteJson, readJson } from './fsUtil'
import { SettingsStore } from './settings'
import { showOpen, showSave } from './dialogs'

/** Resolve the effective directory for open/save dialogs. */
export function resolveDefaultDir(defaultDir: string | null, userData: string): string {
  return defaultDir || userData
}

/** Suggest a `<dataset>.qval.json` filename from the backing tickets path. */
export function suggestEvalName(datasetPath: string | null): string {
  if (!datasetPath) return 'evaluation.qval.json'
  const stem = basename(datasetPath, extname(datasetPath)).replace(/\.qval$/, '')
  return `${stem}.qval.json`
}

/**
 * Owns the in-memory working session (dataset tickets + working eval file + its path) and all file
 * I/O for it. The renderer holds a display copy but never a filesystem path — main tracks the path
 * and does atomic writes (spec §10/§11).
 */
export class Workspace {
  private tickets: Ticket[] = []
  private datasetFp = ''
  private workingFile: EvalFile | null = null
  private workingPath: string | null = null
  /** Read-only comparison files added via MERGE (cleared when the dataset/working file changes). */
  private comparisons: ComparisonFile[] = []
  /** Serializes human edits so rapid changes can't read-merge-write out of order (as in SettingsStore). */
  private editQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly settings: SettingsStore,
    private readonly userData: string,
    private readonly appVersion: string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  snapshot(): SessionSnapshot | null {
    if (!this.workingFile) return null
    return {
      tickets: this.tickets,
      workingFile: this.workingFile,
      workingPath: this.workingPath,
      comparisons: this.comparisons
    }
  }

  currentTickets(): Ticket[] {
    return this.tickets
  }

  currentWorkingFile(): EvalFile | null {
    return this.workingFile
  }

  /**
   * Replace the in-memory working file (bumping `updatedAt`) and, if it has a path, persist it
   * atomically. Used by the evaluation service to write results incrementally.
   */
  async commitWorkingFile(file: EvalFile): Promise<void> {
    this.workingFile = { ...file, meta: { ...file.meta, updatedAt: this.now() } }
    if (this.workingPath) await atomicWriteJson(this.workingPath, this.workingFile)
  }

  /**
   * While the working file is **unlocked** (no scored values yet), keep its config snapshot in sync
   * with the current working schema/rules so the file's fingerprint stays honest as the user sets up
   * the schema. Once a score locks the file, its config is frozen and this is a no-op (spec §3/§4).
   */
  async ensureConfigStamped(): Promise<void> {
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
   * snapshot, and the provider/model from its scored LLM evaluator, so the editors mirror the file
   * (and, once locked, stay pinned to it). Called on open/reload (spec §3).
   */
  private async hydrateSettingsFromFile(file: EvalFile): Promise<void> {
    const patch: Partial<Settings> = {
      schema: file.meta.config.schema,
      rules: file.meta.config.rules
    }
    const llm = file.evaluators.find((e) => e.kind === 'llm' && e.model)
    if (llm?.model && (llm.provider === 'ollama' || llm.provider === 'anthropic')) {
      patch.providerId = llm.provider
      if (llm.provider === 'ollama') {
        const cur = await this.settings.get()
        patch.ollama = { ...cur.ollama, model: llm.model }
      } else {
        patch.anthropic = { model: llm.model }
      }
    }
    await this.settings.set(patch)
  }

  /**
   * Upsert a ticket's human values into the working file and persist. **Serialized** so rapid
   * edits apply in call order without clobbering each other (spec §7).
   */
  async applyHumanEdit(args: { name: string; ticketId: number; values: EvalValues }): Promise<void> {
    const run = async (): Promise<void> => {
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

  /** OPEN: pick a file and auto-detect a tickets.json (→ new working file) vs a *.qval.json. */
  async open(sender: Electron.WebContents): Promise<SessionSnapshot | null> {
    const s = await this.settings.get()
    const res = await showOpen(sender, {
      title: 'Open a tickets.json or a .qval.json eval file',
      defaultPath: resolveDefaultDir(s.defaultDir, this.userData),
      filters: [{ name: 'Qval / Tickets JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    const path = res.filePaths[0]
    if (res.canceled || !path) return null

    const raw = await readJson(path)
    if (raw == null) throw new Error('That file could not be read as JSON.')

    if (looksLikeEvalFile(raw)) return this.openEvalFile(sender, raw, path)

    const parsed = parseTicketsFile(raw)
    if (!parsed) throw new Error('That file is neither a tickets.json nor a .qval.json eval file.')
    return this.importDataset(parsed.tickets, parsed.source, path)
  }

  /** Build a fresh working file from imported tickets + the current schema/rules snapshot. */
  private async importDataset(
    tickets: Ticket[],
    source: { provider?: string; model?: string } | null,
    datasetPath: string
  ): Promise<SessionSnapshot> {
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
    return this.snapshot()!
  }

  /** Load a working eval file, relinking its dataset by fingerprint. */
  private async openEvalFile(
    sender: Electron.WebContents,
    raw: unknown,
    path: string
  ): Promise<SessionSnapshot> {
    const file = normalizeEvalFile(raw)
    if (!file) throw new Error('That .qval.json file is invalid.')
    const tickets = await this.locateDataset(sender, file.meta.dataset.fingerprint)
    if (!tickets) throw new Error('Could not find the tickets.json this eval file was built from.')
    this.tickets = tickets
    this.datasetFp = file.meta.dataset.fingerprint
    this.workingFile = file
    this.workingPath = path
    this.comparisons = []
    await this.hydrateSettingsFromFile(file)
    await this.settings.set({ lastWorkingPath: path })
    return this.snapshot()!
  }

  /** NEW EVALUATION: pick a tickets.json only and start a fresh (editable) working file (spec §3). */
  async newEvaluation(sender: Electron.WebContents): Promise<SessionSnapshot | null> {
    const s = await this.settings.get()
    const res = await showOpen(sender, {
      title: 'New evaluation — choose a tickets.json',
      defaultPath: resolveDefaultDir(s.defaultDir, this.userData),
      filters: [{ name: 'Tickets JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    const path = res.filePaths[0]
    if (res.canceled || !path) return null

    const raw = await readJson(path)
    const parsed = raw ? parseTicketsFile(raw) : null
    if (!parsed) throw new Error('That file is not a tickets.json (a Qbort ticket export).')
    return this.importDataset(parsed.tickets, parsed.source, path)
  }

  /** Find tickets matching `fingerprint`: already-loaded → lastDatasetPath → prompt the user. */
  private async locateDataset(
    sender: Electron.WebContents,
    fingerprint: string
  ): Promise<Ticket[] | null> {
    if (this.datasetFp === fingerprint && this.tickets.length) return this.tickets

    const s = await this.settings.get()
    if (s.lastDatasetPath) {
      const t = await this.tryLoadTickets(s.lastDatasetPath, fingerprint)
      if (t) return t
    }

    const res = await showOpen(sender, {
      title: 'Locate the matching tickets.json for this eval file',
      defaultPath: resolveDefaultDir(s.defaultDir, this.userData),
      filters: [{ name: 'Tickets JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    const p = res.filePaths[0]
    if (res.canceled || !p) return null
    const t = await this.tryLoadTickets(p, fingerprint)
    if (!t) throw new Error('Those tickets do not match this eval file (different dataset).')
    await this.settings.set({ lastDatasetPath: p })
    return t
  }

  /** Read a tickets file and return its tickets only if the fingerprint matches. */
  private async tryLoadTickets(path: string, fingerprint: string): Promise<Ticket[] | null> {
    const raw = await readJson(path)
    const parsed = raw ? parseTicketsFile(raw) : null
    if (!parsed) return null
    const fp = await datasetFingerprint(parsed.tickets)
    return fp === fingerprint ? parsed.tickets : null
  }

  /** Save the working file (Save-As dialog if it has no path yet). Returns the path or null. */
  async save(sender: Electron.WebContents): Promise<string | null> {
    if (!this.workingFile) return null
    let path = this.workingPath
    if (!path) {
      const s = await this.settings.get()
      const res = await showSave(sender, {
        title: 'Save eval file',
        defaultPath: join(resolveDefaultDir(s.defaultDir, this.userData), suggestEvalName(s.lastDatasetPath)),
        filters: [{ name: 'Qval eval file', extensions: ['json'] }]
      })
      if (res.canceled || !res.filePath) return null
      path = res.filePath
    }
    this.workingFile = { ...this.workingFile, meta: { ...this.workingFile.meta, updatedAt: this.now() } }
    await atomicWriteJson(path, this.workingFile)
    this.workingPath = path
    await this.settings.set({ lastWorkingPath: path })
    return path
  }

  /** On launch: silently reload the last working file + its dataset when both match. */
  async loadLast(): Promise<SessionSnapshot | null> {
    const s = await this.settings.get()
    if (!s.lastWorkingPath || !s.lastDatasetPath) return null
    const rawFile = await readJson(s.lastWorkingPath)
    const file = rawFile ? normalizeEvalFile(rawFile) : null
    if (!file) return null
    const tickets = await this.tryLoadTickets(s.lastDatasetPath, file.meta.dataset.fingerprint)
    if (!tickets) return null
    this.tickets = tickets
    this.datasetFp = file.meta.dataset.fingerprint
    this.workingFile = file
    this.workingPath = s.lastWorkingPath
    this.comparisons = []
    await this.hydrateSettingsFromFile(file)
    return this.snapshot()
  }

  /** MERGE: pick a *.qval.json comparison, gate on matching fingerprints, and pool its evaluators. */
  async addComparison(sender: Electron.WebContents): Promise<SessionSnapshot | null> {
    if (!this.workingFile) return null
    const s = await this.settings.get()
    const res = await showOpen(sender, {
      title: 'Merge a .qval.json eval file for comparison',
      defaultPath: resolveDefaultDir(s.defaultDir, this.userData),
      filters: [{ name: 'Qval eval file', extensions: ['json'] }],
      properties: ['openFile']
    })
    const path = res.filePaths[0]
    if (res.canceled || !path) return null
    if (this.comparisons.some((c) => c.id === path)) throw new Error('That file is already merged.')

    const file = normalizeEvalFile(await readJson(path))
    if (!file) throw new Error('That file is not a valid .qval.json eval file.')
    if (file.meta.dataset.fingerprint !== this.workingFile.meta.dataset.fingerprint) {
      throw new Error('Different dataset — this eval file is not of the same tickets.')
    }
    if (file.meta.config.fingerprint !== this.workingFile.meta.config.fingerprint) {
      throw new Error('Different rules or schema — this eval file used different scoring criteria.')
    }
    this.comparisons = [...this.comparisons, { id: path, name: basename(path), evaluators: file.evaluators }]
    return this.snapshot()
  }

  removeComparison(id: string): SessionSnapshot | null {
    this.comparisons = this.comparisons.filter((c) => c.id !== id)
    return this.snapshot()
  }

  /** Write a flat merged aggregate report (per ticket + dataset roll-up) to a chosen path. */
  async exportReport(sender: Electron.WebContents): Promise<string | null> {
    if (!this.workingFile) return null
    const s = await this.settings.get()
    const res = await showSave(sender, {
      title: 'Export merged report',
      defaultPath: join(resolveDefaultDir(s.defaultDir, this.userData), 'qval-report.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return null

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
    await atomicWriteJson(res.filePath, report)
    return res.filePath
  }
}
