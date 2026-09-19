import { useState } from 'react'
import { ClipboardList, Check } from 'lucide-react'
import { TopBar } from '@/components/TopBar'
import { SettingsModal } from '@/components/SettingsModal'
import { MergeModal } from '@/components/MergeModal'
import { DatasetView } from '@/components/DatasetView'
import { ToastProvider, useToast } from '@/state/ToastContext'
import { SettingsProvider } from '@/state/SettingsContext'
import { SessionProvider, useSession } from '@/state/SessionContext'
import { errorMessage } from '@/lib/format'
import { api } from '@/lib/apiClient'

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="brutal-box max-w-md p-8 text-center">
      <ClipboardList className="mx-auto h-10 w-10" strokeWidth={1.5} />
      <h1 className="mt-4 font-mono text-lg font-bold uppercase tracking-widest">No dataset loaded</h1>
      <p className="mt-2 text-sm text-ink/60">
        Close this tab and run <span className="font-mono">/qval:review</span> in a directory holding a
        ticket file or a <span className="font-mono">.qval.json</span> evaluation file. Any{' '}
        <span className="font-mono">.json</span> in the ticket format counts, whatever it is named. Qval
        opens whatever the command line points it at.
      </p>
      {loading ? (
        <div className="mt-6 font-mono text-[11px] uppercase tracking-widest text-ink/40">Loading…</div>
      ) : null}
    </div>
  )
}

/**
 * Where a review session ends. The server has stopped by the time this renders, so it is a dead end
 * on purpose: there is nothing left to click, and saying so beats a page that quietly 401s.
 */
function FinishedState({ workingPath }: { workingPath: string | null }) {
  return (
    <div className="flex h-full items-center justify-center bg-paper p-8">
      <div className="brutal-box max-w-md p-8 text-center">
        <Check className="mx-auto h-10 w-10" strokeWidth={1.5} />
        <h1 className="mt-4 font-mono text-lg font-bold uppercase tracking-widest">Review finished</h1>
        <p className="mt-2 text-sm text-ink/60">
          Everything is saved. You can close this tab — run <span className="font-mono">/qval:status</span> in
          Claude Code to see the result.
        </p>
        {workingPath ? <p className="mt-4 break-all font-mono text-[11px] text-ink/40">{workingPath}</p> : null}
      </div>
    </div>
  )
}

function AppShell() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [finished, setFinished] = useState(false)
  const { session, loading } = useSession()
  const { toast } = useToast()

  const hasDataset = !!session

  // POST /api/done is what turns an `abandoned` session into a `done` one; without it the CLI can
  // only ever infer the end from the tab going away.
  const finish = async () => {
    try {
      await api.review.done()
      setFinished(true)
    } catch (e) {
      toast(errorMessage(e, 'Could not end the session'), 'error')
    }
  }

  if (finished) return <FinishedState workingPath={session?.workingPath ?? null} />

  return (
    <div className="flex h-full flex-col bg-paper">
      <TopBar
        hasDataset={hasDataset}
        candidateCount={session?.candidates.length ?? 0}
        onMerge={() => setMergeOpen(true)}
        onFinish={finish}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex flex-1 items-start justify-center overflow-auto p-8">
        {hasDataset ? <DatasetView /> : <EmptyState loading={loading} />}
      </main>

      <MergeModal open={mergeOpen} onOpenChange={setMergeOpen} />
      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}

export function App() {
  return (
    <ToastProvider>
      <SettingsProvider>
        <SessionProvider>
          <AppShell />
        </SessionProvider>
      </SettingsProvider>
    </ToastProvider>
  )
}
