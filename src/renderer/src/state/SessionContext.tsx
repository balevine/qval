import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { EvalFile, SessionSnapshot } from '@shared/types'
import { createSafeContext } from '@/lib/createSafeContext'
import { api } from '@/lib/apiClient'

interface SessionContextValue {
  session: SessionSnapshot | null
  /** The host's version, off the same boot response as the session. Nothing renders it yet. */
  appVersion: string | null
  loading: boolean
  /** Replace the whole session (after a merge) or clear it. */
  setSession: (session: SessionSnapshot | null) => void
  /** Replace the working file (after a run or a human edit), keeping tickets + path. */
  applyWorkingFile: (file: EvalFile) => void
}

const [SessionContext, useSession] = createSafeContext<SessionContextValue>('Session')
export { useSession }

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionSnapshot | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // One boot call for the working file, its dataset, and the host's version.
  useEffect(() => {
    let active = true
    api.session
      .boot()
      .then(({ appVersion: v, session: s }) => {
        if (!active) return
        setAppVersion(v)
        if (s) setSession(s)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const applyWorkingFile = useCallback((file: EvalFile) => {
    setSession((prev) => (prev ? { ...prev, workingFile: file } : prev))
  }, [])

  return (
    <SessionContext.Provider value={{ session, appVersion, loading, setSession, applyWorkingFile }}>
      {children}
    </SessionContext.Provider>
  )
}
