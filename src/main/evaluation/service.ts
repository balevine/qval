import type {
  CostEstimate,
  EvalFile,
  EvalRunResult,
  EvaluationProgress,
  RunMode,
  Settings,
  Ticket
} from '@shared/types'
import { applyLlmResults, LLM_EVALUATOR_ID, lockedLlmProvider, needsAttention } from '@shared/evalFile'
import type { ProviderId } from '@shared/types'
import type { SettingsStore } from '../settings'
import type { SecretStore } from '../secrets'
import type { Workspace } from '../storage'
import { runEvaluation } from './orchestrator'
import { estimateRun } from './estimate'
import { createProvider, type LLMProvider } from './providers'

/** How the service builds its provider — injectable so tests can supply a fake (no network). */
export type ProviderFactory = (
  settings: Settings,
  getKey: (provider: ProviderId) => Promise<string | null>
) => Promise<LLMProvider>

/** Batch size + concurrency per provider: Ollama is single-GPU (small, sequential); hosted parallel. */
function runParams(settings: Settings): { batchSize: number; concurrency: number } {
  if (settings.providerId === 'ollama') return { batchSize: Math.min(settings.batchSize, 5), concurrency: 1 }
  return { batchSize: Math.max(1, settings.batchSize), concurrency: Math.max(1, settings.concurrency) }
}

/**
 * Pin provider+model to the file's scored LLM evaluator once it's locked, so a re-run of the
 * remaining tickets uses the same model (no finishing an Ollama run with Anthropic — spec §3/§4).
 */
export function effectiveRunSettings(settings: Settings, file: EvalFile): Settings {
  const pinned = lockedLlmProvider(file)
  if (!pinned?.model) return settings
  if (pinned.provider === 'ollama') {
    return { ...settings, providerId: 'ollama', ollama: { ...settings.ollama, model: pinned.model } }
  }
  if (pinned.provider === 'anthropic') {
    return { ...settings, providerId: 'anthropic', anthropic: { model: pinned.model } }
  }
  return settings
}

/** The config a run/estimate uses: schema/rules from the file (authoritative), provider/model pinned if locked. */
export function effectiveConfig(settings: Settings, file: EvalFile): Settings {
  const eff = effectiveRunSettings(settings, file)
  return { ...eff, schema: file.meta.config.schema, rules: file.meta.config.rules }
}

/** Pick the tickets an LLM run targets (spec §6 re-run modes). */
export function selectTargets(mode: RunMode, tickets: Ticket[], file: EvalFile): Ticket[] {
  if (mode.kind === 'selection') {
    const want = new Set(mode.ticketIds)
    return tickets.filter((t) => want.has(t.id))
  }
  if (mode.kind === 'all') return tickets
  // 'remaining' — unevaluated, errored, or with an unresolved dropped value.
  const llm = file.evaluators.find((e) => e.id === LLM_EVALUATOR_ID && e.kind === 'llm')
  const byId = new Map((llm?.results ?? []).map((r) => [r.ticketId, r]))
  return tickets.filter((t) => needsAttention(byId.get(t.id)))
}

/**
 * Coordinates an LLM run: builds the provider, runs the orchestrator over the target tickets,
 * merges results into the working file's `llm` evaluator, persists incrementally, and enforces
 * one-run-at-a-time.
 */
export class EvaluationService {
  private active: AbortController | null = null

  constructor(
    private readonly settings: SettingsStore,
    private readonly secrets: SecretStore,
    private readonly workspace: Workspace,
    private readonly buildProvider: ProviderFactory = createProvider
  ) {}

  async estimate(mode: RunMode): Promise<CostEstimate> {
    const settings = await this.settings.get()
    await this.workspace.ensureConfigStamped()
    const file = this.workspace.currentWorkingFile()
    if (!file) throw new Error('No dataset loaded.')
    const targets = selectTargets(mode, this.workspace.currentTickets(), file)
    return estimateRun(effectiveConfig(settings, file), targets, runParams(settings).batchSize)
  }

  cancel(): void {
    this.active?.abort()
  }

  /** True while a run is in flight — the working file is read-only until it finishes (no concurrent edits). */
  isRunning(): boolean {
    return this.active !== null
  }

  async start(mode: RunMode, onProgress: (p: EvaluationProgress) => void): Promise<EvalRunResult> {
    if (this.active) throw new Error('An evaluation is already running.')
    const controller = new AbortController()
    this.active = controller
    try {
      return await this.run(mode, controller, onProgress)
    } finally {
      this.active = null
    }
  }

  private async run(
    mode: RunMode,
    controller: AbortController,
    onProgress: (p: EvaluationProgress) => void
  ): Promise<EvalRunResult> {
    const settings = await this.settings.get()
    // Pin the file's config to the current schema/rules before the run locks it, then read the
    // authoritative schema/rules + pinned model straight from the file (spec §3/§4).
    await this.workspace.ensureConfigStamped()
    const base = this.workspace.currentWorkingFile()
    if (!base) throw new Error('No dataset loaded.')
    const targets = selectTargets(mode, this.workspace.currentTickets(), base)
    const provider = await this.buildProvider(effectiveRunSettings(settings, base), (p) => this.secrets.getKey(p))
    const { batchSize, concurrency } = runParams(settings)

    // Coalescing single-flight writer so concurrent batches don't race the atomic write.
    let pending: EvalFile | null = null
    let writing: Promise<void> | null = null
    const scheduleCommit = (file: EvalFile): Promise<void> => {
      pending = file
      if (writing) return writing
      writing = (async () => {
        try {
          while (pending) {
            const next = pending
            pending = null
            await this.workspace.commitWorkingFile(next)
          }
        } finally {
          writing = null
        }
      })()
      return writing
    }

    const run = await runEvaluation({
      provider,
      schema: base.meta.config.schema,
      rules: base.meta.config.rules,
      tickets: targets,
      signal: controller.signal,
      batchSize,
      concurrency,
      onProgress,
      onResults: (results) =>
        scheduleCommit(applyLlmResults(base, { provider: provider.id, model: provider.model, results }))
    })

    if (writing) await writing
    const finalFile = applyLlmResults(base, {
      provider: provider.id,
      model: provider.model,
      results: run.results
    })
    await this.workspace.commitWorkingFile(finalFile)

    return {
      workingFile: this.workspace.currentWorkingFile()!,
      cancelled: run.cancelled,
      stats: { evaluated: run.results.length, failed: run.failed, retries: run.retries }
    }
  }
}
