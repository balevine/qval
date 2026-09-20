import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { SchemaEditor } from '@/components/SchemaEditor'
import { RulesEditor } from '@/components/RulesEditor'
import { StorageSettings } from '@/components/StorageSettings'
import { HelpTooltip } from '@/components/ui/help-tooltip'
import { cn } from '@/lib/utils'

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface Tab {
  id: string
  label: string
  note?: string
  /** Optional detail shown in a `?` hover tooltip beside the note. */
  help?: ReactNode
  render: () => ReactNode
}

const SCHEMA_HELP = (
  <ul className="space-y-1.5">
    <li>
      <span className="font-mono font-bold text-ink">Label</span> — the display name people see (e.g. “Empathy”).
    </li>
    <li>
      <span className="font-mono font-bold text-ink">Key</span> — the stable id used in the saved JSON and the LLM
      prompt (auto-filled from the label; must be unique).
    </li>
    <li>
      <span className="font-mono font-bold text-ink">Type</span> — the value kind: score (number range), boolean,
      enum (pick one), or text. “Allow multiple” makes it an array (multi-select).
    </li>
    <li>
      <span className="font-mono font-bold text-ink">Description</span> — guidance shown to the human evaluator{' '}
      <em>and</em> injected into the LLM prompt.
    </li>
  </ul>
)

const TABS: Tab[] = [
  {
    id: 'schema',
    label: 'Schema',
    note: 'The typed output properties each ticket is scored on.',
    help: SCHEMA_HELP,
    render: () => <SchemaEditor />
  },
  {
    id: 'rules',
    label: 'Rules',
    note: 'Free-form context that tells the evaluator how to score.',
    render: () => <RulesEditor />
  },
  {
    id: 'storage',
    label: 'Evaluator',
    note: 'Who you are, and which file your scores are being written to.',
    render: () => <StorageSettings />
  }
]

/** Tabbed settings modal — a menu across the top, one section visible at a time. */
export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const [activeId, setActiveId] = useState(TABS[0].id)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  // Start on the first tab each time the modal opens.
  useEffect(() => {
    if (open) setActiveId(TABS[0].id)
  }, [open])

  const activeIndex = Math.max(0, TABS.findIndex((t) => t.id === activeId))
  const active = TABS[activeIndex]

  const onKeyDown = (e: React.KeyboardEvent) => {
    let next = activeIndex
    if (e.key === 'ArrowRight') next = (activeIndex + 1) % TABS.length
    else if (e.key === 'ArrowLeft') next = (activeIndex - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = TABS.length - 1
    else return
    e.preventDefault()
    setActiveId(TABS[next].id)
    tabRefs.current[next]?.focus()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[80vh] max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        {/* Tab strip */}
        <div
          role="tablist"
          aria-label="Settings sections"
          onKeyDown={onKeyDown}
          className="flex flex-wrap gap-px border-b-2 border-ink bg-ink"
        >
          {TABS.map((tab, i) => {
            const selected = tab.id === activeId
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[i] = el
                }}
                role="tab"
                aria-selected={selected}
                aria-controls={`panel-${tab.id}`}
                id={`tab-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveId(tab.id)}
                className={cn(
                  'px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-widest transition-colors',
                  selected ? 'bg-paper text-ink' : 'bg-ink text-paper/70 hover:text-paper'
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        <DialogBody
          role="tabpanel"
          id={`panel-${active.id}`}
          aria-labelledby={`tab-${active.id}`}
          className="min-h-0 flex-1"
        >
          {active.note || active.help ? (
            <div className="mb-4 flex items-start justify-between gap-3">
              <p className="text-xs text-ink/50">{active.note}</p>
              {active.help ? <HelpTooltip label={`About ${active.label}`}>{active.help}</HelpTooltip> : null}
            </div>
          ) : null}
          {active.render()}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
