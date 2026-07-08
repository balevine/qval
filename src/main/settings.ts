import { join } from 'path'
import type { Settings } from '@shared/types'
import { mergeSettings, withDefaults } from '@shared/settings'
import { atomicWriteJson, readJson } from './fsUtil'

/**
 * Reads/writes the persisted `settings.json`. The directory is injected so the store is
 * testable against a temp dir without booting Electron.
 */
export class SettingsStore {
  private readonly file: string
  private cache: Settings | null = null
  /** Tail of the write queue — serializes `set()` so concurrent updates apply in call order. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dir: string) {
    this.file = join(dir, 'settings.json')
  }

  async get(): Promise<Settings> {
    if (this.cache) return this.cache
    // Missing or corrupt file → withDefaults(null) yields the defaults.
    this.cache = withDefaults(await readJson(this.file))
    return this.cache
  }

  /**
   * Persist a partial update. Writes are **serialized**: each set waits for the previous one to
   * finish (cache updated + file written) before it reads-merges-writes, so rapid-fire updates
   * (e.g. per-keystroke edits) can't interleave and clobber each other — the last call wins, and
   * updates to different fields all survive.
   */
  async set(partial: Partial<Settings>): Promise<Settings> {
    const run = async (): Promise<Settings> => {
      const current = await this.get()
      const next = mergeSettings(current, partial)
      await atomicWriteJson(this.file, next)
      this.cache = next
      return next
    }
    // Chain onto the queue whether the previous write resolved or rejected (one failure must not
    // wedge the chain); keep the queue itself rejection-free.
    const result = this.queue.then(run, run) as Promise<Settings>
    this.queue = result.catch(() => undefined)
    return result
  }
}
