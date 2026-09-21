// File-backed settings store. The pure defaults/merge logic lives in `settings.mjs`; this is the
// thin persistence shell around it, kept separate so the pure half stays free of fs.

import { join } from 'node:path'
import { mergeSettings, withDefaults } from './settings.mjs'
import { atomicWriteJson, readJson } from './fsUtil.mjs'

/** @typedef {import('@shared/types').Settings} Settings */

/**
 * Reads/writes the persisted `settings.json`. The directory is injected so the store is testable
 * against a temp dir, and so the host decides where it lives (the CLI puts it in the run directory,
 * `.qval-run/`, beside the session record).
 */
export class SettingsStore {
  /** @param {string} dir */
  constructor(dir) {
    /** @type {string} */
    this.file = join(dir, 'settings.json')
    /** @type {Settings | null} */
    this.cache = null
    /** Tail of the write queue. Serializes `set()` so concurrent updates apply in call order. */
    this.queue = Promise.resolve()
  }

  /** @returns {Promise<Settings>} */
  async get() {
    if (this.cache) return this.cache
    // Missing or corrupt file → withDefaults(null) yields the defaults.
    this.cache = withDefaults(await readJson(this.file))
    return this.cache
  }

  /**
   * Persist a partial update. Writes are **serialized**: each set waits for the previous one to
   * finish (cache updated + file written) before it reads-merges-writes, so rapid-fire updates
   * (e.g. per-keystroke edits) can't interleave and clobber each other. The last call wins, and
   * updates to different fields all survive.
   * @param {Partial<Settings>} partial
   * @returns {Promise<Settings>}
   */
  async set(partial) {
    const run = async () => {
      const current = await this.get()
      const next = mergeSettings(current, partial)
      await atomicWriteJson(this.file, next)
      this.cache = next
      return next
    }
    // Chain onto the queue whether the previous write resolved or rejected (one failure must not
    // wedge the chain); keep the queue itself rejection-free.
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }
}
