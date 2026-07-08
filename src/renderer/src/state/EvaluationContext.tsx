import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { EvalRunResult, EvaluationProgress, RunMode } from '@shared/types'
import { createSafeContext } from '@/lib/createSafeContext'
import { useSession } from '@/state/SessionContext'
import { useToast } from '@/state/ToastContext'
import { errorMessage } from '@/lib/format'

interface EvaluationContextValue {
  phase: 'idle' | 'running'
  progress: EvaluationProgress | null
  lastStats: EvalRunResult['stats'] | null
  start: (mode: RunMode) => Promise<void>
  cancel: () => void
}

const [EvaluationContext, useEvaluation] = createSafeContext<EvaluationContextValue>('Evaluation')
export { useEvaluation }

/**
 * Owns LLM-run state at the app level so it survives the Evaluate modal opening/closing (spec §13):
 * subscribes to progress, applies the returned working file to the session, and surfaces results.
 */
export function EvaluationProvider({ children }: { children: ReactNode }) {
  const { applyWorkingFile } = useSession()
  const { toast } = useToast()
  const [phase, setPhase] = useState<'idle' | 'running'>('idle')
  const [progress, setProgress] = useState<EvaluationProgress | null>(null)
  const [lastStats, setLastStats] = useState<EvalRunResult['stats'] | null>(null)
  const running = useRef(false)

  const start = useCallback(
    async (mode: RunMode) => {
      if (running.current) return
      running.current = true
      setPhase('running')
      setProgress(null)
      setLastStats(null)
      const unsubscribe = window.api.evaluation.onProgress(setProgress)
      try {
        const result = await window.api.evaluation.start(mode)
        applyWorkingFile(result.workingFile)
        setLastStats(result.stats)
        toast(
          result.cancelled
            ? `Cancelled — ${result.stats.evaluated} evaluated`
            : `Evaluated ${result.stats.evaluated} tickets${result.stats.failed ? `, ${result.stats.failed} failed` : ''}`,
          result.stats.failed ? 'error' : 'default'
        )
      } catch (e) {
        toast(errorMessage(e, 'Evaluation failed'), 'error')
      } finally {
        unsubscribe()
        running.current = false
        setPhase('idle')
      }
    },
    [applyWorkingFile, toast]
  )

  const cancel = useCallback(() => {
    window.api.evaluation.cancel()
  }, [])

  return (
    <EvaluationContext.Provider value={{ phase, progress, lastStats, start, cancel }}>
      {children}
    </EvaluationContext.Provider>
  )
}
