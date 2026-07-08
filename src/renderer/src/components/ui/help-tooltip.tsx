import { type ReactNode } from 'react'
import { CircleHelp } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A `?`-in-a-circle icon that reveals help content on hover or keyboard focus. Neo-brutalist:
 * a hard-bordered popover, square corners, mono text. The trigger is focusable for a11y; the
 * popover opens downward from the icon's right edge.
 */
export function HelpTooltip({
  children,
  label = 'Help',
  className
}: {
  children: ReactNode
  label?: string
  className?: string
}) {
  return (
    <span className={cn('group relative inline-flex', className)}>
      <button
        type="button"
        aria-label={label}
        className="text-ink/50 outline-none transition-colors hover:text-ink focus-visible:text-ink"
      >
        <CircleHelp className="h-5 w-5" />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden w-80 border-2 border-ink bg-paper p-3 text-xs leading-relaxed text-ink/70 shadow-brutal group-hover:block group-focus-within:block"
      >
        {children}
      </span>
    </span>
  )
}
