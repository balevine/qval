import { Lock } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Neo-brutalist banner shown atop a Settings section that is frozen because the working file
 * already has scores (its config/model is pinned to keep the eval file honest).
 */
export function LockNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 border-2 border-ink bg-ink/5 px-3 py-2">
      <Lock className="mt-px h-3.5 w-3.5 shrink-0 text-ink" />
      <p className="font-mono text-[11px] leading-relaxed text-ink/70">{children}</p>
    </div>
  )
}
