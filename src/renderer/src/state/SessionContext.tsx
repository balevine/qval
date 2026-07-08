import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { EvalFile, SessionSnapshot } from '@shared/types'
import { createSafeContext } from '@/lib/createSafeContext'

interface SessionContextValue {
  session: SessionSnapshot | null
  loading: boolean
  /** Replace the whole session (after OPEN) or clear it. */
  setSession: (session: SessionSnapshot | null) => void
  /** Update just the working-file path (after a save). */
  setWorkingPath: (path: string | null) => void
  /** Replace the working file (after a run or a human edit), keeping tickets + path. */
  applyWorkingFile: (file: EvalFile) => void
}

const [SessionContext, useSession] = createSafeContext<SessionContextValue>('Session')
export { useSession }

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionSnapshot | null>(null)
  const [loading, setLoading] = useState(true)

  // Try to silently reload the last working file + its dataset on launch.
  useEffect(() => {
    let active = true
    window.api.session
      .loadLast()
      .then((s) => {
        if (active && s) setSession(s)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const setWorkingPath = useCallback((path: string | null) => {
    setSession((prev) => (prev ? { ...prev, workingPath: path } : prev))
  }, [])

  const applyWorkingFile = useCallback((file: EvalFile) => {
    setSession((prev) => (prev ? { ...prev, workingFile: file } : prev))
  }, [])

  return (
    <SessionContext.Provider value={{ session, loading, setSession, setWorkingPath, applyWorkingFile }}>
      {children}
    </SessionContext.Provider>
  )
}
