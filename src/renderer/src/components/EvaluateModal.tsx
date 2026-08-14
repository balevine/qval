import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SectionHeader } from '@/components/ui/section-header'
import { PulseDot } from '@/components/ui/pulse-dot'
import { useSession } from '@/state/SessionContext'
import { useSettings } from '@/state/SettingsContext'
import { useEvaluation } from '@/state/EvaluationContext'
import { useToast } from '@/state/ToastContext'
import { useSecretStatus } from '@/lib/useSecretStatus'
import { formatCost, formatInt, errorMessage } from '@/lib/format'
import { llmRunBlockReason, LLM_EVALUATOR_ID, needsAttention } from '@shared/evalFile'
import { evaluationReadiness } from '@shared/readiness'
import type { CostEstimate, RunMode } from '@shared/types'

interface EvaluateModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type ModeKind = 'all' | 'remaining'

export function EvaluateModal({ open, onOpenChange }: EvaluateModalProps) {
  const { session } = useSession()
  const { settings } = useSettings()
  const { secretStatus, refresh: refreshSecrets } = useSecretStatus()
  const { phase, progress, lastStats, start, cancel } = useEvaluation()
  const { toast } = useToast()
  const [modeKind, setModeKind] = useState<ModeKind>('all')
  const [estimate, setEstimate] = useState<CostEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)

  const mode: RunMode = { kind: modeKind }
  const running = phase === 'running'
  // A file the Claude Code skill scored can't be continued here (spec §18): no estimate, no run.
  const blockReason = llmRunBlockReason(session?.workingFile)

  // Count how many tickets each mode targets (for the mode buttons).
  const counts = (() => {
    if (!session) return { all: 0, remaining: 0 }
    const llm = session.workingFile.evaluators.find((e) => e.id === LLM_EVALUATOR_ID)
    const byId = new Map((llm?.results ?? []).map((r) => [r.ticketId, r]))
    const remaining = session.tickets.filter((t) => needsAttention(byId.get(t.id))).length
    return { all: session.tickets.length, remaining }
  })()

  // Refresh the key status when the modal opens (a key may have been added since app launch).
  useEffect(() => {
    if (open) refreshSecrets()
  }, [open, refreshSecrets])

  // (Re)fetch the estimate when the modal opens or the mode changes (and no run is active).
  useEffect(() => {
    if (!open || running || blockReason) return
    let active = true
    setEstimating(true)
    setEstimate(null)
    window.api.evaluation
      .estimate(mode)
      .then((e) => active && setEstimate(e))
      .catch((e) => active && toast(errorMessage(e, 'Could not estimate'), 'error'))
      .finally(() => active && setEstimating(false))
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, modeKind, running, blockReason])

  const targetCount = counts[modeKind]
  const readiness = settings
    ? evaluationReadiness(settings, !!secretStatus[settings.providerId], session?.workingFile)
    : { ready: false, message: 'Loading…' }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Evaluate</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {/* Run mode */}
          <div className="grid grid-cols-2 gap-2">
            <ModeButton
              label="All tickets"
              count={counts.all}
              active={modeKind === 'all'}
              disabled={running}
              onClick={() => setModeKind('all')}
            />
            <ModeButton
              label="Needs attention"
              count={counts.remaining}
              active={modeKind === 'remaining'}
              disabled={running}
              onClick={() => setModeKind('remaining')}
            />
          </div>

          {/* Estimate gate. Skipped for a blocked file, which `estimate` refuses too. */}
          {blockReason ? null : (
            <div className="border-2 border-ink">
              <SectionHeader title="Estimate" />
              <div className="p-3">
                {estimating ? (
                  <div className="flex items-center gap-2 font-mono text-xs text-ink/60">
                    <Loader2 className="h-4 w-4 animate-spin" /> Estimating…
                  </div>
                ) : estimate ? (
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-xs">
                    <Row label="Model" value={estimate.model || '—'} />
                    <Row label="Tickets" value={formatInt(estimate.targetCount)} />
                    <Row label="Batches" value={formatInt(estimate.batches)} />
                    <Row label="Est. tokens" value={`~${formatInt(estimate.estimatedTotalTokens)}`} />
                    <Row
                      label="Est. cost"
                      value={
                        estimate.isLocal
                          ? '$0 · local'
                          : estimate.priceKnown && estimate.estimatedCostUsd !== null
                            ? formatCost(estimate.estimatedCostUsd, { isLocal: false, approx: true })
                            : '— (price unknown)'
                      }
                    />
                  </div>
                ) : (
                  <div className="font-mono text-xs text-ink/50">No estimate.</div>
                )}
              </div>
            </div>
          )}

          {/* Progress */}
          {running && progress ? (
            <div className="border-2 border-ink">
              <SectionHeader title="Running" />
              <div className="space-y-2 p-3">
                <div className="h-3 w-full border-2 border-ink">
                  <div className="h-full bg-ink" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
                </div>
                <div className="flex items-center gap-3 font-mono text-[11px] text-ink/70">
                  <PulseDot />
                  <span>
                    {formatInt(progress.ticketsDone)}/{formatInt(progress.ticketsTotal)} tickets ·{' '}
                    {progress.batchesDone}/{progress.batchesTotal} batches
                    {progress.retries ? ` · ${progress.retries} retries` : ''}
                    {progress.failed ? ` · ${progress.failed} failed` : ''}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {lastStats && !running ? (
            <div className="font-mono text-[11px] uppercase tracking-widest text-ink/50">
              Last run: {lastStats.evaluated} evaluated
              {lastStats.failed ? `, ${lastStats.failed} failed` : ''}
              {lastStats.retries ? `, ${lastStats.retries} retries` : ''}
            </div>
          ) : null}

          {/* Not-ready hint */}
          {!running && !readiness.ready ? (
            <div className="border-l-[6px] border-ink bg-ink/5 px-3 py-2 font-mono text-[11px] text-ink/70">
              {readiness.message}
            </div>
          ) : null}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            {running ? (
              <Button variant="outline" onClick={cancel}>
                Cancel
              </Button>
            ) : (
              <Button
                variant="solid"
                onClick={() => start(mode)}
                disabled={targetCount === 0 || !readiness.ready}
              >
                {targetCount === 0 ? 'Nothing to evaluate' : `Run · ${formatInt(targetCount)} tickets`}
              </Button>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function ModeButton({
  label,
  count,
  active,
  disabled,
  onClick
}: {
  label: string
  count: number
  active: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        'border-2 border-ink px-3 py-2 text-left transition-colors disabled:opacity-40 ' +
        (active ? 'bg-ink text-paper' : 'bg-paper text-ink hover:bg-ink/10')
      }
    >
      <div className="font-mono text-xs font-bold uppercase tracking-wide">{label}</div>
      <div className="font-mono text-[10px] uppercase tracking-widest opacity-70">{formatInt(count)} tickets</div>
    </button>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-ink/50">{label}</span>
      <span className="truncate font-bold text-ink" title={value}>
        {value}
      </span>
    </div>
  )
}
