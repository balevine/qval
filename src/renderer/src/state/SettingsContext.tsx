import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Settings } from '@shared/types'
import { createSafeContext } from '@/lib/createSafeContext'
import { api } from '@/lib/apiClient'

interface SettingsContextValue {
  settings: Settings | null
  loading: boolean
  /** Apply a partial update locally and persist it (coalesced; see `flush`). */
  update: (partial: Partial<Settings>) => void
  /** Write any pending update through now. Call before anything that reads settings host-side. */
  flush: () => Promise<void>
}

/**
 * How long to wait after the last edit before saving, so a burst of typing becomes one save.
 *
 * Every save writes the settings file, and on a file that has no scores yet it also rewrites the
 * whole eval file to record the schema being used. Saving on each keystroke means rewriting both
 * files for every character typed. This is short enough to feel instant and long enough that
 * typing a sentence saves once.
 */
const WRITE_DEBOUNCE_MS = 400

const [SettingsContext, useSettings] = createSafeContext<SettingsContextValue>('Settings')
export { useSettings }

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  /** Monotonic id of the latest update; stale responses (from earlier edits) don't reconcile. */
  const latestSeq = useRef(0)

  useEffect(() => {
    let active = true
    api.settings
      .get()
      .then((s) => {
        if (active) setSettings(s)
      })
      .catch((err) => console.error('settings.get failed', err))
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  /** Fields edited since the last write, merged in edit order. Null when nothing is pending. */
  const pending = useRef<Partial<Settings> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const writePending = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const patch = pending.current
    if (!patch) return
    pending.current = null
    // Reconcile with the host's merged result, but only for the *latest* write: a slow response to
    // an earlier one must not overwrite newer local state (which would revert characters mid-type).
    const seq = ++latestSeq.current
    const next = await api.settings.set(patch)
    if (seq === latestSeq.current) setSettings(next)
  }, [])

  const update = useCallback(
    (partial: Partial<Settings>) => {
      // Local state moves immediately; the write is coalesced behind it.
      setSettings((prev) => (prev ? { ...prev, ...partial } : prev))
      pending.current = { ...pending.current, ...partial }
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        void writePending().catch((err) => console.error('settings.set failed', err))
      }, WRITE_DEBOUNCE_MS)
    },
    [writePending]
  )

  // A pending write must not die with the tab: the host reads the settings store when the session
  // ends, to hand the schema and rules back to the evaluation skill.
  useEffect(() => {
    const onHide = () => {
      if (pending.current) void writePending().catch(() => {})
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      onHide()
    }
  }, [writePending])

  return (
    <SettingsContext.Provider value={{ settings, loading, update, flush: writePending }}>
      {children}
    </SettingsContext.Provider>
  )
}
