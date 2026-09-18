import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Settings } from '@shared/types'
import { createSafeContext } from '@/lib/createSafeContext'
import { api } from '@/lib/apiClient'

interface SettingsContextValue {
  settings: Settings | null
  loading: boolean
  /** Persist a partial update; returns the merged settings from the host. */
  update: (partial: Partial<Settings>) => Promise<void>
  /** Re-pull settings from the host (e.g. after opening a file hydrates its schema/rules). */
  refresh: () => Promise<void>
}

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

  const update = useCallback(async (partial: Partial<Settings>) => {
    // Optimistic local update for snappy UI, then reconcile with main's merged result — but only
    // for the *latest* update. A slow response from an earlier keystroke must not overwrite newer
    // state with a stale value (which would revert/lose characters while typing fast).
    setSettings((prev) => (prev ? { ...prev, ...partial } : prev))
    const seq = ++latestSeq.current
    const next = await api.settings.set(partial)
    if (seq === latestSeq.current) setSettings(next)
  }, [])

  const refresh = useCallback(async () => {
    // Bump the seq so any in-flight optimistic `update` responses don't clobber the fresh pull.
    const seq = ++latestSeq.current
    const next = await api.settings.get()
    if (seq === latestSeq.current) setSettings(next)
  }, [])

  return (
    <SettingsContext.Provider value={{ settings, loading, update, refresh }}>
      {children}
    </SettingsContext.Provider>
  )
}
