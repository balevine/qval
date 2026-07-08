import { useState } from 'react'
import { ClipboardList } from 'lucide-react'
import { TopBar } from '@/components/TopBar'
import { SettingsModal } from '@/components/SettingsModal'
import { EvaluateModal } from '@/components/EvaluateModal'
import { DatasetView } from '@/components/DatasetView'
import { ToastProvider, useToast } from '@/state/ToastContext'
import { SettingsProvider, useSettings } from '@/state/SettingsContext'
import { SessionProvider, useSession } from '@/state/SessionContext'
import { EvaluationProvider, useEvaluation } from '@/state/EvaluationContext'
import { errorMessage, formatInt } from '@/lib/format'

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="brutal-box max-w-md p-8 text-center">
      <ClipboardList className="mx-auto h-10 w-10" strokeWidth={1.5} />
      <h1 className="mt-4 font-mono text-lg font-bold uppercase tracking-widest">No dataset loaded</h1>
      <p className="mt-2 text-sm text-ink/60">
        Click <span className="font-bold">Open</span> to import a{' '}
        <span className="font-mono">tickets.json</span> (from Qbort) or an existing{' '}
        <span className="font-mono">.qval.json</span> evaluation file.
      </p>
      {loading ? (
        <div className="mt-6 font-mono text-[11px] uppercase tracking-widest text-ink/40">Loading…</div>
      ) : null}
    </div>
  )
}

function AppShell() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [evaluateOpen, setEvaluateOpen] = useState(false)
  const { session, loading, setSession, setWorkingPath } = useSession()
  const { refresh: refreshSettings } = useSettings()
  const { phase } = useEvaluation()
  const { toast } = useToast()

  const hasDataset = !!session
  // While an LLM run is in flight the working file is read-only (main enforces this too) — sequential only.
  const busy = phase === 'running'

  const open = async () => {
    try {
      const next = await window.api.session.open()
      if (next) {
        setSession(next)
        // Opening a .qval.json hydrates schema/rules/provider from its snapshot — pull them in.
        await refreshSettings()
        toast(`Loaded ${formatInt(next.tickets.length)} tickets`)
      }
    } catch (e) {
      toast(errorMessage(e, 'Could not open that file'), 'error')
    }
  }

  const newEvaluation = async () => {
    try {
      const next = await window.api.session.newEvaluation()
      if (next) {
        setSession(next)
        toast(`New evaluation — ${formatInt(next.tickets.length)} tickets`)
      }
    } catch (e) {
      toast(errorMessage(e, 'Could not start a new evaluation'), 'error')
    }
  }

  const exportFile = async () => {
    try {
      const path = await window.api.session.save()
      if (path) {
        setWorkingPath(path)
        toast('Saved eval file')
      }
    } catch (e) {
      toast(errorMessage(e, 'Could not save'), 'error')
    }
  }

  const merge = async () => {
    try {
      const next = await window.api.session.addComparison()
      if (next) {
        setSession(next)
        toast('Merged eval file')
      }
    } catch (e) {
      toast(errorMessage(e, 'Could not merge that file'), 'error')
    }
  }

  return (
    <div className="flex h-full flex-col bg-paper">
      <TopBar
        hasDataset={hasDataset}
        busy={busy}
        onOpen={open}
        onNew={newEvaluation}
        onEvaluate={() => setEvaluateOpen(true)}
        onMerge={merge}
        onExport={exportFile}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex flex-1 items-start justify-center overflow-auto p-8">
        {hasDataset ? <DatasetView /> : <EmptyState loading={loading} />}
      </main>

      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
      <EvaluateModal open={evaluateOpen} onOpenChange={setEvaluateOpen} />
    </div>
  )
}

export function App() {
  return (
    <ToastProvider>
      <SettingsProvider>
        <SessionProvider>
          <EvaluationProvider>
            <AppShell />
          </EvaluationProvider>
        </SessionProvider>
      </SettingsProvider>
    </ToastProvider>
  )
}
