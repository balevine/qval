import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { formatInt } from '@/lib/format'

/** First/prev/next/last pager with a page indicator (neo-brutalist). */
export function Pagination({
  page,
  pageCount,
  total,
  onPage
}: {
  page: number
  pageCount: number
  total: number
  onPage: (page: number) => void
}) {
  const go = (p: number) => onPage(Math.min(pageCount - 1, Math.max(0, p)))
  return (
    <div className="flex items-center justify-between gap-3 border-t-2 border-ink bg-ink/5 px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink/50">
        {formatInt(total)} rows · page {formatInt(page + 1)} / {formatInt(pageCount)}
      </span>
      <div className="flex gap-1">
        <IconButton aria-label="First page" disabled={page === 0} onClick={() => go(0)}>
          <ChevronFirst className="h-4 w-4" />
        </IconButton>
        <IconButton aria-label="Previous page" disabled={page === 0} onClick={() => go(page - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
        <IconButton aria-label="Next page" disabled={page >= pageCount - 1} onClick={() => go(page + 1)}>
          <ChevronRight className="h-4 w-4" />
        </IconButton>
        <IconButton aria-label="Last page" disabled={page >= pageCount - 1} onClick={() => go(pageCount - 1)}>
          <ChevronLast className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  )
}
