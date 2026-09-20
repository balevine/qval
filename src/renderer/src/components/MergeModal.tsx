import { useState } from 'react'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useSession } from '@/state/SessionContext'
import { errorMessage } from '@/lib/format'
import { api } from '@/lib/apiClient'

interface MergeModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * MERGE, in a browser that cannot open a file dialog and a server that accepts no paths.
 * The CLI scans the working directory for other `*.qval.json` files and offers them by name; this
 * lists that offer and merges by id.
 *
 * A refusal is the interesting case, so it is shown per row rather than in a toast: "different
 * dataset" and "different rules or schema" are facts about the two files that the user has to act
 * on, and pooling two files' scores is only meaningful when both fingerprints match.
 */
export function MergeModal({ open, onOpenChange }: MergeModalProps) {
  const { session, setSession } = useSession()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const candidates = session?.candidates ?? []

  const toggle = async (id: string, merged: boolean) => {
    setBusyId(id)
    try {
      const next = merged ? await api.session.unmergeComparison(id) : await api.session.mergeComparison(id)
      if (next) setSession(next)
      setErrors((prev) => {
        const { [id]: _dropped, ...rest } = prev
        return rest
      })
    } catch (e) {
      setErrors((prev) => ({ ...prev, [id]: errorMessage(e, 'Could not merge that file') }))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Merge eval files</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="mb-4 text-xs text-ink/50">
            Other <span className="font-mono">.qval.json</span> files found next to this one. Merging pools their
            evaluators into the comparison; it never changes them or your working file.
          </p>

          {candidates.length === 0 ? (
            <p className="font-mono text-xs uppercase tracking-widest text-ink/40">No other eval files found</p>
          ) : (
            <ul className="space-y-2">
              {candidates.map((c) => (
                <li key={c.id} className="border-2 border-ink p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-xs">{c.name}</span>
                    <Button
                      size="sm"
                      variant={c.merged ? 'solid' : 'outline'}
                      disabled={busyId === c.id}
                      onClick={() => toggle(c.id, c.merged)}
                    >
                      {c.merged ? 'Merged' : 'Merge'}
                    </Button>
                  </div>
                  {errors[c.id] ? (
                    <p className="mt-2 border-t-2 border-ink/10 pt-2 text-[11px] text-ink/60">{errors[c.id]}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
