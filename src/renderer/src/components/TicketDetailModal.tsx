import { useMemo } from 'react'
import { ChevronLeft, ChevronRight, SkipForward } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogBody } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { HumanEvalForm } from '@/components/HumanEvalForm'
import { useSession } from '@/state/SessionContext'
import { useSettings } from '@/state/SettingsContext'
import { useToast } from '@/state/ToastContext'
import { applyHumanValues, ownResults } from '@lib/evalFile.mjs'
import { aggregateSession, buildStreams, streamLabel } from '@lib/aggregate.mjs'
import { formatComparisonCell } from '@/lib/aggregateFormat'
import { cn } from '@/lib/utils'
import { errorMessage, formatEvalValue, formatInt, formatTimestamp } from '@/lib/format'
import { api } from '@/lib/apiClient'
import type { ComparisonFile, EvalFile, EvalValues, Ticket } from '@shared/types'

interface TicketDetailModalProps {
  tickets: Ticket[]
  index: number | null
  onIndexChange: (index: number | null) => void
}

/**
 * The conversation + human-eval form for one ticket (spec §7/§9.2). Human edits are applied to the
 * session optimistically and persisted host-side; prev/next/next-unevaluated sweep the queue.
 */
export function TicketDetailModal({ tickets, index, onIndexChange }: TicketDetailModalProps) {
  const { session, applyWorkingFile } = useSession()
  const { settings } = useSettings()
  const { toast } = useToast()

  const file = session?.workingFile
  const humanById = useMemo(
    () => new Map((file ? ownResults(file, 'human') : []).map((r) => [r.ticketId, r])),
    [file]
  )
  const llmById = useMemo(
    () => new Map((file ? ownResults(file, 'llm') : []).map((r) => [r.ticketId, r])),
    [file]
  )
  const evaluatedIds = useMemo(
    () => new Set(Array.from(humanById.values()).filter((r) => Object.keys(r.values).length > 0).map((r) => r.ticketId)),
    [humanById]
  )

  const ticket = index !== null ? tickets[index] : null
  const open = ticket !== null

  if (!ticket || !file) {
    return <Dialog open={false} onOpenChange={() => onIndexChange(null)} />
  }

  const humanValues = humanById.get(ticket.id)?.values ?? {}
  const llmResult = llmById.get(ticket.id) ?? null
  const comparisons = session?.comparisons ?? []

  const onChange = (values: EvalValues) => {
    const name = settings?.evaluatorName || 'Me'
    applyWorkingFile(applyHumanValues(file, { name, ticketId: ticket.id, values, now: new Date().toISOString() }))
    api.human.setValues(ticket.id, values).catch((e) => toast(errorMessage(e, 'Could not save'), 'error'))
  }

  const go = (i: number) => onIndexChange(Math.min(tickets.length - 1, Math.max(0, i)))
  const nextUnevaluated = () => {
    for (let step = 1; step <= tickets.length; step++) {
      const i = (index! + step) % tickets.length
      if (!evaluatedIds.has(tickets[i].id)) return onIndexChange(i)
    }
    toast('All tickets have a human evaluation')
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onIndexChange(null)}>
      <DialogContent className="h-[86vh] max-w-5xl">
        <DialogHeader className="flex items-center justify-between gap-4 pr-14">
          <div className="min-w-0">
            <div className="font-mono text-sm font-bold uppercase tracking-widest">
              #{ticket.id} · {ticket.status}
            </div>
            <div className="truncate text-xs text-paper/70" title={ticket.subject}>
              {ticket.subject || '(no subject)'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-paper/60">
              {formatInt(index! + 1)} / {formatInt(tickets.length)}
            </span>
            <IconButton aria-label="Previous ticket" disabled={index === 0} onClick={() => go(index! - 1)} className="border-paper bg-ink text-paper hover:bg-paper hover:text-ink">
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
            <IconButton aria-label="Next ticket" disabled={index === tickets.length - 1} onClick={() => go(index! + 1)} className="border-paper bg-ink text-paper hover:bg-paper hover:text-ink">
              <ChevronRight className="h-4 w-4" />
            </IconButton>
            <IconButton aria-label="Next unevaluated" title="Next unevaluated" onClick={nextUnevaluated} className="border-paper bg-ink text-paper hover:bg-paper hover:text-ink">
              <SkipForward className="h-4 w-4" />
            </IconButton>
          </div>
        </DialogHeader>

        <DialogBody className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2">
          {/* Conversation */}
          <div className="min-h-0 overflow-auto pr-1">
            <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-ink/40">
              Conversation
            </div>
            <div className="space-y-3">
              {ticket.messages.map((m, i) => (
                <div
                  key={i}
                  className={cn('border-2 border-ink p-3', m.isStaff ? 'bg-staff/20' : 'bg-paper')}
                >
                  <div className="mb-1 flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-widest text-ink/50">
                    <span className="truncate">
                      {m.isStaff ? 'STAFF' : 'CUSTOMER'} · {m.from.name}
                    </span>
                    <span className="shrink-0">{formatTimestamp(m.createdAt)}</span>
                  </div>
                  <div className="whitespace-pre-wrap text-xs text-ink">{m.body}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Human eval form */}
          <div className="min-h-0 overflow-auto border-l-2 border-ink/10 pl-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink/40">
                Your evaluation
              </span>
              {evaluatedIds.has(ticket.id) ? (
                <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink">● scored</span>
              ) : (
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink/30">○ not scored</span>
              )}
            </div>
            {llmResult?.error ? (
              <div className="mb-3 border-l-[6px] border-ink bg-ink/5 px-3 py-2 font-mono text-[11px] text-ink/70">
                LLM eval failed for this ticket: {llmResult.error}
              </div>
            ) : null}
            <HumanEvalForm
              schema={file.meta.config.schema}
              values={humanValues}
              llmValues={llmResult?.values ?? null}
              llmIssues={llmResult?.issues ?? null}
              onChange={onChange}
            />
          </div>
        </div>

        {comparisons.length > 0 ? <SideBySide file={file} comparisons={comparisons} ticketId={ticket.id} /> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/** Per-evaluator values for this ticket (LLM columns then human columns) + the comparison. */
function SideBySide({ file, comparisons, ticketId }: { file: EvalFile; comparisons: ComparisonFile[]; ticketId: number }) {
  const streams = buildStreams(file, comparisons)
  const cols = [...streams.filter((s) => s.kind === 'llm'), ...streams.filter((s) => s.kind === 'human')]
  const ta = aggregateSession(file, comparisons, [ticketId]).byTicket[ticketId]

  return (
    <div className="max-h-44 overflow-auto border-t-2 border-ink">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b-2 border-ink bg-ink text-paper">
            <th className="px-2 py-1 text-left font-mono text-[9px] font-bold uppercase tracking-widest">Property</th>
            {cols.map((s, i) => (
              <th key={i} className={cn('px-2 py-1 text-left font-mono text-[9px] font-bold uppercase tracking-widest', s.kind === 'human' && cols[i - 1]?.kind === 'llm' && 'border-l-2 border-paper')}>
                {streamLabel(s.name, s.source)}
              </th>
            ))}
            <th className="border-l-2 border-paper px-2 py-1 text-left font-mono text-[9px] font-bold uppercase tracking-widest">L vs H</th>
          </tr>
        </thead>
        <tbody>
          {file.meta.config.schema.map((p) => (
            <tr key={p.key} className="border-b border-ink/10">
              <td className="px-2 py-1 font-mono font-bold text-ink">{p.label}</td>
              {cols.map((s, i) => (
                <td key={i} className={cn('px-2 py-1 font-mono text-ink/70', s.kind === 'human' && cols[i - 1]?.kind === 'llm' && 'border-l-2 border-ink/20')}>
                  {formatEvalValue(s.byTicket.get(ticketId)?.values[p.key])}
                </td>
              ))}
              <td className="border-l-2 border-ink/20 px-2 py-1 font-mono text-ink/70">
                {formatComparisonCell(ta.llm[p.key], ta.human[p.key], ta.comparison[p.key]).text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
