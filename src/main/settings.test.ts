import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore } from './settings'
import { DEFAULT_SETTINGS } from '@shared/settings'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'qv-settings-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  it('returns defaults when no file exists', async () => {
    const store = new SettingsStore(dir)
    expect(await store.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('persists a partial update and reloads it', async () => {
    const store = new SettingsStore(dir)
    await store.set({ providerId: 'anthropic', evaluatorName: 'Brian L.' })
    const reloaded = await new SettingsStore(dir).get()
    expect(reloaded.providerId).toBe('anthropic')
    expect(reloaded.evaluatorName).toBe('Brian L.')
  })

  it('merges nested ollama/anthropic field-by-field', async () => {
    const store = new SettingsStore(dir)
    await store.set({ ollama: { host: 'http://host:1', model: 'llama' } })
    const next = await store.set({ ollama: { model: 'qwen' } as never })
    expect(next.ollama.host).toBe('http://host:1') // sibling preserved
    expect(next.ollama.model).toBe('qwen')
  })

  it('clamps out-of-range numeric settings', async () => {
    const next = await new SettingsStore(dir).set({ concurrency: 999, batchSize: 0 })
    expect(next.concurrency).toBe(16) // max
    expect(next.batchSize).toBe(1) // min
  })

  it('falls back to defaults on a corrupt file', async () => {
    await fs.writeFile(join(dir, 'settings.json'), 'not json', 'utf-8')
    expect((await new SettingsStore(dir).get()).providerId).toBe('ollama')
  })

  it('serializes concurrent updates so no field is clobbered', async () => {
    const store = new SettingsStore(dir)
    // Fired concurrently against different fields — an unserialized read-merge-write would drop
    // whichever writes land out of order.
    await Promise.all([
      store.set({ concurrency: 8 }),
      store.set({ batchSize: 9 }),
      store.set({ evaluatorName: 'X' })
    ])
    const reloaded = await new SettingsStore(dir).get()
    expect(reloaded.concurrency).toBe(8)
    expect(reloaded.batchSize).toBe(9)
    expect(reloaded.evaluatorName).toBe('X')
  })

  it('applies concurrent same-field updates in call order (last wins, none lost mid-way)', async () => {
    const store = new SettingsStore(dir)
    await Promise.all(['a', 'b', 'c'].map((rules) => store.set({ rules })))
    expect((await new SettingsStore(dir).get()).rules).toBe('c')
  })
})
