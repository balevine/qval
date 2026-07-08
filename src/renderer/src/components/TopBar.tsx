import { Download, FolderOpen, GitMerge, Settings, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface TopBarProps {
  /** Whether a dataset/working file is loaded (gates evaluate/merge/export). */
  hasDataset: boolean
  /** True while an LLM run is in flight — the working file is read-only, so file actions are disabled. */
  busy: boolean
  onOpen: () => void
  onEvaluate: () => void
  onMerge: () => void
  onExport: () => void
  onOpenSettings: () => void
}

/**
 * Single-page top bar: title on the left; OPEN, EVALUATE, MERGE, EXPORT, and settings on the right
 * (see spec §13). OPEN auto-detects a tickets.json (fresh evaluation) or a *.qval.json (resume one);
 * EVALUATE is the primary (solid) action. While a run is in flight, actions that would change or
 * swap the working file are disabled (the run has exclusive access).
 */
export function TopBar({ hasDataset, busy, onOpen, onEvaluate, onMerge, onExport, onOpenSettings }: TopBarProps) {
  const busyTitle = busy ? 'Disabled while an evaluation is running' : undefined
  return (
    <header className="flex items-center justify-between border-b-2 border-ink bg-paper px-5 py-3">
      <div className="flex items-baseline gap-3">
        <span className="border-2 border-ink bg-ink px-2 py-1 font-mono text-sm font-bold uppercase tracking-widest text-paper">
          Qval
        </span>
        <span className="hidden font-mono text-xs uppercase tracking-widest text-ink/50 sm:inline">
          ticket evaluation
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onOpen} disabled={busy} title={busyTitle}>
          <FolderOpen className="h-4 w-4" />
          Open
        </Button>
        <Button variant="solid" onClick={onEvaluate} disabled={!hasDataset}>
          <Sparkles className="h-4 w-4" />
          Evaluate
        </Button>
        <Button variant="outline" onClick={onMerge} disabled={!hasDataset || busy} title={busyTitle}>
          <GitMerge className="h-4 w-4" />
          Merge
        </Button>
        <Button variant="outline" onClick={onExport} disabled={!hasDataset}>
          <Download className="h-4 w-4" />
          Export
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
        >
          <Settings className="h-5 w-5" />
        </Button>
      </div>
    </header>
  )
}
