import { Check, GitMerge, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface TopBarProps {
  /** Whether a dataset/working file is loaded (gates merge). */
  hasDataset: boolean
  /** How many files the host found to merge; 0 hides the affordance entirely. */
  candidateCount: number
  onMerge: () => void
  onFinish: () => void
  onOpenSettings: () => void
}

/**
 * Single-page top bar: title on the left; MERGE, FINISH, and settings on the right.
 *
 * There is no OPEN and no EXPORT here any more. The CLI binds the files before the tab exists, the
 * server persists every edit as it happens, and the report export lives next to the merged roster
 * it belongs to, in the summary. There is no EVALUATE either — the LLM run is
 * `/qval:evaluate-tickets`.
 */
export function TopBar({ hasDataset, candidateCount, onMerge, onFinish, onOpenSettings }: TopBarProps) {
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
        {candidateCount > 0 ? (
          <Button variant="outline" onClick={onMerge} disabled={!hasDataset}>
            <GitMerge className="h-4 w-4" />
            Merge
          </Button>
        ) : null}
        <Button variant="outline" onClick={onFinish} title="End the review session and close the server">
          <Check className="h-4 w-4" />
          Finish
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
