import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore } from '@lib/settingsStore.mjs'
import { DEFAULT_SETTINGS } from '@lib/settings.mjs'

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
    await store.set({ lastDatasetPath: '/tmp/tickets.json', evaluatorName: 'Brian L.' })
    const reloaded = await new SettingsStore(dir).get()
    expect(reloaded.lastDatasetPath).toBe('/tmp/tickets.json')
    expect(reloaded.evaluatorName).toBe('Brian L.')
  })

  it('leaves the fields an update does not name alone', async () => {
    const store = new SettingsStore(dir)
    await store.set({ evaluatorName: 'Ada', lastDatasetPath: '/tmp/tickets.json' })
    const next = await store.set({ evaluatorName: 'Grace' })
    expect(next.lastDatasetPath).toBe('/tmp/tickets.json') // sibling preserved
    expect(next.evaluatorName).toBe('Grace')
  })

  it('falls back to defaults on a corrupt file', async () => {
    await fs.writeFile(join(dir, 'settings.json'), 'not json', 'utf-8')
    expect(await new SettingsStore(dir).get()).toEqual(DEFAULT_SETTINGS)
  })

  it('serializes concurrent updates so no field is clobbered', async () => {
    const store = new SettingsStore(dir)
    // Fired concurrently against different fields. An unserialized read-merge-write would drop
    // whichever writes land out of order.
    await Promise.all([
      store.set({ rules: 'be kind' }),
      store.set({ lastDatasetPath: '/tmp/tickets.json' }),
      store.set({ evaluatorName: 'X' })
    ])
    const reloaded = await new SettingsStore(dir).get()
    expect(reloaded.rules).toBe('be kind')
    expect(reloaded.lastDatasetPath).toBe('/tmp/tickets.json')
    expect(reloaded.evaluatorName).toBe('X')
  })

  it('applies concurrent same-field updates in call order (last wins, none lost mid-way)', async () => {
    const store = new SettingsStore(dir)
    await Promise.all(['a', 'b', 'c'].map((rules) => store.set({ rules })))
    expect((await new SettingsStore(dir).get()).rules).toBe('c')
  })
})
