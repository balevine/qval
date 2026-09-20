import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Download, X } from 'lucide-react'
import { useSession } from '@/state/SessionContext'
import { useToast } from '@/state/ToastContext'
import { TicketDetailModal } from '@/components/TicketDetailModal'
import { Pagination } from '@/components/Pagination'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { aggregateSession, buildStreams, streamLabel } from '@lib/aggregate.mjs'
import { evaluatedCount } from '@lib/evalFile.mjs'
import { TICKET_STATUSES, type AggregateResult, type EvalFile, type Ticket } from '@shared/types'
import { formatComparisonCell, formatRollup, formatStreamCell } from '@/lib/aggregateFormat'
import { errorMessage, formatInt } from '@/lib/format'
import { cn } from '@/lib/utils'
import { api } from '@/lib/apiClient'

const PAGE_SIZE = 100
type Mode = 'compare' | 'llm' | 'human'

export function DatasetView() {
  const { session } = useSession()
  const [page, setPage] = useState(0)
  const [status, setStatus] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState<Mode>('compare')
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  const tickets = session?.tickets ?? []
  const workingFile = session?.workingFile

  const agg = useMemo<AggregateResult | null>(
    () => (workingFile ? aggregateSession(workingFile, session!.comparisons, tickets.map((t) => t.id)) : null),
    [workingFile, session, tickets]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tickets.filter((t) => {
      if (status !== 'all' && t.status !== status) return false
      if (!q) return true
      const hay = `${t.subject} ${t.messages.map((m) => `${m.from.name} ${m.body}`).join(' ')}`.toLowerCase()
      return hay.includes(q)
    })
  }, [tickets, status, search])

  useEffect(() => setPage(0), [status, search])

  if (!session || !workingFile || !agg) return null

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageTickets = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

  return (
    <div className="w-full max-w-6xl space-y-4">
      <Summary file={workingFile} tickets={tickets} agg={agg} comparisons={session.comparisons} workingPath={session.workingPath} />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search subject + messages…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64"
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {TICKET_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex border-2 border-ink">
          {(['compare', 'llm', 'human'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors',
                mode === m ? 'bg-ink text-paper' : 'bg-paper text-ink hover:bg-ink/10'
              )}
            >
              {m === 'compare' ? 'Compare' : m === 'llm' ? 'LLM' : 'Human'}
            </button>
          ))}
        </div>
      </div>

      <ResultsTable
        file={workingFile}
        tickets={pageTickets}
        agg={agg}
        mode={mode}
        onOpen={(t) => setOpenIndex(filtered.indexOf(t))}
      />
      <Pagination page={page} pageCount={pageCount} total={filtered.length} onPage={setPage} />

      <TicketDetailModal tickets={filtered} index={openIndex} onIndexChange={setOpenIndex} />
    </div>
  )
}

// --- summary -----------------------------------------------------------------

function Summary({
  file,
  tickets,
  agg,
  comparisons,
  workingPath
}: {
  file: EvalFile
  tickets: Ticket[]
  agg: AggregateResult
  comparisons: import('@shared/types').ComparisonFile[]
  workingPath: string | null
}) {
  const { setSession } = useSession()
  const { toast } = useToast()
  const streams = useMemo(() => buildStreams(file, comparisons), [file, comparisons])
  const llmNames = streams.filter((s) => s.kind === 'llm').map((s) => streamLabel(s.name, s.source))
  const humanNames = streams.filter((s) => s.kind === 'human').map((s) => streamLabel(s.name, s.source))
  const merged = comparisons.length > 0

  const removeComparison = async (id: string) => {
    const next = await api.session.unmergeComparison(id)
    if (next) setSession(next)
  }
  const exportReport = async () => {
    try {
      // The destination is derived from the working file, not chosen — so say where it went.
      const path = await api.session.exportReport()
      if (path) toast(`Exported ${path}`)
    } catch (e) {
      toast(errorMessage(e, 'Could not export report'), 'error')
    }
  }

  return (
    <div className="brutal-box p-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Stat label="Tickets" value={formatInt(tickets.length)} />
        <Stat label="Source" value={file.meta.dataset.source?.model ?? file.meta.dataset.source?.provider ?? '—'} />
        <Stat label="LLM eval" value={`${formatInt(evaluatedCount(file, 'llm'))} / ${formatInt(tickets.length)}`} />
        <Stat label="Human eval" value={`${formatInt(evaluatedCount(file, 'human'))} / ${formatInt(tickets.length)}`} />
      </div>

      {/* Evaluator roster */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t-2 border-ink/10 pt-3">
        <Roster label="LLM" names={llmNames} />
        <Roster label="Human" names={humanNames} />
        {comparisons.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => removeComparison(c.id)}
            title="Remove merged file"
            className="flex items-center gap-1 border-2 border-ink px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest hover:bg-ink hover:text-paper"
          >
            {c.name} <X className="h-3 w-3" />
          </button>
        ))}
        {merged ? (
          <button
            type="button"
            onClick={exportReport}
            className="ml-auto flex items-center gap-1 border-2 border-ink px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest hover:bg-ink hover:text-paper"
          >
            <Download className="h-3 w-3" /> Export report
          </button>
        ) : null}
      </div>

      {/* Dataset-level human-vs-LLM roll-up */}
      {merged || evaluatedCount(file, 'human') > 0 ? (
        <div className="mt-3 border-t-2 border-ink/10 pt-3">
          <div className="mb-1 font-mono text-[10px] font-bold uppercase tracking-widest text-ink/40">
            Human vs LLM · per property
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {file.meta.config.schema.map((p) => (
              <span key={p.key} className="font-mono text-[11px] text-ink/70">
                <span className="font-bold text-ink">{p.label}:</span> {formatRollup(agg.rollup[p.key])}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-3 font-mono text-[10px] uppercase tracking-widest text-ink/40">
        Working file: {workingPath ?? 'unsaved'}
      </div>
    </div>
  )
}

function Roster({ label, names }: { label: string; names: string[] }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink/50">{label}</span>
      <span className="font-mono text-[11px] text-ink/70">{names.length ? names.join(', ') : '—'}</span>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink/50">{label}</div>
      <div className="truncate font-mono text-sm font-bold text-ink" title={value}>
        {value}
      </div>
    </div>
  )
}

// --- table -------------------------------------------------------------------

function ResultsTable({
  file,
  tickets,
  agg,
  mode,
  onOpen
}: {
  file: EvalFile
  tickets: Ticket[]
  agg: AggregateResult
  mode: Mode
  onOpen: (t: Ticket) => void
}) {
  const schema = file.meta.config.schema
  return (
    <div className="brutal-box overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b-2 border-ink bg-ink text-paper">
            <Th className="w-14">#</Th>
            <Th className="min-w-[16rem] text-left">Subject</Th>
            <Th className="w-20">Status</Th>
            {schema.map((p) => (
              <Th key={p.key} className="min-w-[9rem] text-left">
                {p.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => {
            const ta = agg.byTicket[t.id]
            return (
              <tr
                key={t.id}
                onClick={() => onOpen(t)}
                className="cursor-pointer border-b border-ink/10 hover:bg-ink/[0.04]"
              >
                <td className="px-3 py-2 font-mono text-ink/60">#{t.id}</td>
                <td className="max-w-0 truncate px-3 py-2" title={t.subject}>
                  {t.subject || <span className="text-ink/30">(no subject)</span>}
                </td>
                <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink/60">{t.status}</td>
                {schema.map((p) => (
                  <Cell key={p.key} ta={ta} propKey={p.key} mode={mode} />
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Cell({ ta, propKey, mode }: { ta: import('@shared/types').TicketAggregate | undefined; propKey: string; mode: Mode }) {
  if (!ta) return <td className="px-3 py-2 font-mono text-[11px] text-ink/30">—</td>
  if (mode === 'llm') {
    return <td className="px-3 py-2 font-mono text-[11px] text-ink/80">{formatStreamCell(ta.llm[propKey])}</td>
  }
  if (mode === 'human') {
    return <td className="px-3 py-2 font-mono text-[11px] text-ink/80">{formatStreamCell(ta.human[propKey])}</td>
  }
  const { text, disagree } = formatComparisonCell(ta.llm[propKey], ta.human[propKey], ta.comparison[propKey])
  return (
    <td className={cn('px-3 py-2 font-mono text-[11px]', disagree ? 'font-bold text-ink' : 'text-ink/80')}>{text}</td>
  )
}

function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th className={cn('px-3 py-2 text-center font-mono text-[10px] font-bold uppercase tracking-widest', className)}>
      {children}
    </th>
  )
}
