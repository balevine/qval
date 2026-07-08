import { describe, expect, it, vi } from 'vitest'
import { EvaluationService, effectiveConfig, effectiveRunSettings, selectTargets } from './service'
import { applyLlmResults, createWorkingFile, ownResults } from '@shared/evalFile'
import { DEFAULT_RULES } from '@shared/rules'
import { DEFAULT_SCHEMA } from '@shared/schema'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { EvalFile, EvalResult, Settings, Ticket } from '@shared/types'
import type { GenerateBatchArgs, GenerateBatchResult, LLMProvider } from './providers'
import type { SettingsStore } from '../settings'
import type { SecretStore } from '../secrets'
import type { Workspace } from '../storage'

const tickets: Ticket[] = [1, 2, 3].map((id) => ({
  id,
  subject: `S${id}`,
  status: 'open',
  messages: []
}))

const base = createWorkingFile({
  appVersion: '0.1.0',
  now: 't',
  dataset: { fingerprint: 'sha256:a', ticketCount: 3, source: null },
  config: { fingerprint: 'sha256:b', schema: DEFAULT_SCHEMA, rules: DEFAULT_RULES }
})

const res = (ticketId: number, over: Partial<EvalResult> = {}): EvalResult => ({
  ticketId,
  values: { empathy: 4 },
  evaluatedAt: 't',
  error: null,
  ...over
})

describe('selectTargets', () => {
  it('all → every ticket', () => {
    expect(selectTargets({ kind: 'all' }, tickets, base).map((t) => t.id)).toEqual([1, 2, 3])
  })

  it('selection → only requested ids', () => {
    expect(selectTargets({ kind: 'selection', ticketIds: [2] }, tickets, base).map((t) => t.id)).toEqual([2])
  })

  it('remaining → unevaluated, errored, or dropped-value tickets', () => {
    const file = applyLlmResults(base, {
      provider: 'anthropic',
      model: 'm',
      results: [
        res(1), // clean → skipped
        res(2, { error: 'boom' }), // errored → included
        res(3, { issues: [{ key: 'category', action: 'dropped' }] }) // dropped → included
      ]
    })
    // ticket 1 clean; 2 errored; 3 dropped → remaining = [2, 3]
    expect(selectTargets({ kind: 'remaining' }, tickets, file).map((t) => t.id)).toEqual([2, 3])
  })
})

describe('effectiveRunSettings / effectiveConfig', () => {
  const settings: Settings = { ...DEFAULT_SETTINGS, providerId: 'anthropic', anthropic: { model: 'claude-x' } }

  it('leaves settings untouched when the file has no scored LLM values', () => {
    expect(effectiveRunSettings(settings, base)).toBe(settings)
  })

  it('pins provider+model to the scored LLM evaluator once locked', () => {
    const file = applyLlmResults(base, {
      provider: 'ollama',
      model: 'llama3.1',
      results: [{ ticketId: 1, values: { empathy: 4 }, evaluatedAt: 't', error: null }]
    })
    const eff = effectiveRunSettings(settings, file)
    expect(eff.providerId).toBe('ollama')
    expect(eff.ollama.model).toBe('llama3.1')
    // effectiveConfig also swaps schema/rules to the file's authoritative snapshot.
    expect(effectiveConfig(settings, file).schema).toBe(file.meta.config.schema)
    expect(effectiveConfig(settings, file).rules).toBe(file.meta.config.rules)
  })
})

// A fake provider that answers every ticket in the batch (reads ids from the compiled prompt).
class FakeProvider implements LLMProvider {
  readonly id = 'ollama' as const
  readonly model = 'llama'
  async generateBatch(args: GenerateBatchArgs): Promise<GenerateBatchResult> {
    const ids = [...args.dynamicSuffix!.matchAll(/### Ticket (\d+):/g)].map((m) => Number(m[1]))
    return { raw: Object.fromEntries(ids.map((id) => [id, { resolved: true, categories: ['bug'] }])), usage: { inputTokens: 1, outputTokens: 1 } }
  }
}

describe('EvaluationService.start (integration)', () => {
  it('runs a full evaluation through the orchestrator and merges + persists into the working file', async () => {
    const workingFile = createWorkingFile({
      appVersion: '0.1.0',
      now: 't',
      dataset: { fingerprint: 'sha256:a', ticketCount: 3, source: null },
      config: { fingerprint: 'sha256:b', schema: DEFAULT_SCHEMA, rules: DEFAULT_RULES }
    })
    const fakeWorkspace = {
      file: workingFile,
      committed: null as EvalFile | null,
      currentWorkingFile() {
        return this.file
      },
      currentTickets() {
        return tickets
      },
      async ensureConfigStamped() {
        /* unlocked no-op in this fixture */
      },
      async commitWorkingFile(f: EvalFile) {
        this.file = f
        this.committed = f
      }
    }
    const settings: Settings = { ...DEFAULT_SETTINGS, providerId: 'ollama', ollama: { host: 'h', model: 'llama' }, batchSize: 2, concurrency: 1 }
    const fakeSettings = { get: vi.fn().mockResolvedValue(settings) }
    const fakeSecrets = { getKey: vi.fn().mockResolvedValue(null) }

    const service = new EvaluationService(
      fakeSettings as unknown as SettingsStore,
      fakeSecrets as unknown as SecretStore,
      fakeWorkspace as unknown as Workspace,
      async () => new FakeProvider()
    )

    const result = await service.start({ kind: 'all' }, () => {})

    expect(result.stats).toMatchObject({ evaluated: 3, failed: 0 })
    const llm = ownResults(result.workingFile, 'llm')
    expect(llm.map((r) => r.ticketId)).toEqual([1, 2, 3])
    expect(llm.every((r) => r.values.resolved === true)).toBe(true)
    expect(fakeWorkspace.committed).not.toBeNull() // persisted through the workspace
  })

  it('isRunning() reflects an in-flight run and a concurrent start is refused', async () => {
    // A provider that blocks until we release it, so we can observe the mid-run state.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    class BlockingProvider implements LLMProvider {
      readonly id = 'ollama' as const
      readonly model = 'llama'
      async generateBatch(args: GenerateBatchArgs): Promise<GenerateBatchResult> {
        await gate
        const ids = [...args.dynamicSuffix!.matchAll(/### Ticket (\d+):/g)].map((m) => Number(m[1]))
        return { raw: Object.fromEntries(ids.map((id) => [id, { resolved: true }])), usage: { inputTokens: 1, outputTokens: 1 } }
      }
    }
    const workingFile = createWorkingFile({
      appVersion: '0.1.0', now: 't',
      dataset: { fingerprint: 'sha256:a', ticketCount: 3, source: null },
      config: { fingerprint: 'sha256:b', schema: DEFAULT_SCHEMA, rules: DEFAULT_RULES }
    })
    const fakeWorkspace = {
      currentWorkingFile: () => workingFile,
      currentTickets: () => tickets,
      async ensureConfigStamped() {},
      async commitWorkingFile() {}
    }
    const settings: Settings = { ...DEFAULT_SETTINGS, providerId: 'ollama', ollama: { host: 'h', model: 'llama' }, concurrency: 1 }
    const service = new EvaluationService(
      { get: vi.fn().mockResolvedValue(settings) } as unknown as SettingsStore,
      { getKey: vi.fn().mockResolvedValue(null) } as unknown as SecretStore,
      fakeWorkspace as unknown as Workspace,
      async () => new BlockingProvider()
    )

    expect(service.isRunning()).toBe(false)
    const inFlight = service.start({ kind: 'all' }, () => {})
    expect(service.isRunning()).toBe(true)
    await expect(service.start({ kind: 'all' }, () => {})).rejects.toThrow(/already running/)

    release()
    await inFlight
    expect(service.isRunning()).toBe(false)
  })
})
