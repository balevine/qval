import { type ReactNode } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { formatEvalValue } from '@/lib/format'
import { clampScore } from '@lib/evalValidate.mjs'
import type { EvalIssue, EvalProperty, EvalSchema, EvalValue, EvalValues } from '@shared/types'

interface HumanEvalFormProps {
  schema: EvalSchema
  /** The human's current values for this ticket (controlled). */
  values: EvalValues
  /** The LLM's values for this ticket, shown for reference (never pre-fills the human's). */
  llmValues: EvalValues | null
  /** The LLM result's validation-repair trail, shown as read-only badges next to the reference. */
  llmIssues?: EvalIssue[] | null
  onChange: (values: EvalValues) => void
}

/** The number of discrete steps in a score range (for rendering it as buttons when small). */
function scoreSteps(p: EvalProperty): number[] | null {
  const min = p.min ?? 1
  const max = p.max ?? 5
  const step = p.step && p.step > 0 ? p.step : 1
  const n = Math.floor((max - min) / step) + 1
  if (n < 2 || n > 12) return null // too many → fall back to a number input
  return Array.from({ length: n }, (_, i) => Number((min + i * step).toFixed(6)))
}

/**
 * Renders one editable field per schema property. Booleans/enums/small scores are
 * click-to-toggle segmented buttons (re-click clears → unscored); larger scores use a number
 * input; text uses a textarea. The LLM's value is shown for reference, clearly labeled.
 */
export function HumanEvalForm({ schema, values, llmValues, llmIssues, onChange }: HumanEvalFormProps) {
  const set = (key: string, value: EvalValue | undefined) => {
    const next = { ...values }
    if (value === undefined) delete next[key]
    else next[key] = value
    onChange(next)
  }

  const issueByKey = new Map((llmIssues ?? []).map((i) => [i.key, i]))

  return (
    <fieldset className="m-0 space-y-5 border-0 p-0">
      {schema.map((p) => {
        const v = values[p.key]
        return (
          <div key={p.key}>
            <div className="font-mono text-xs font-bold uppercase tracking-widest text-ink">{p.label}</div>
            {p.description ? <div className="mt-0.5 text-[11px] text-ink/50">{p.description}</div> : null}

            <div className="mt-2">
              <Field p={p} value={v} onSet={(val) => set(p.key, val)} />
            </div>

            <LlmReference llmValues={llmValues} propKey={p.key} issue={issueByKey.get(p.key)} />
          </div>
        )
      })}
    </fieldset>
  )
}

/**
 * Read-only LLM reference value for one property, with a badge when the automatic per-value repair
 * altered or dropped the model's raw output. A `dropped` value shows a "— (dropped)" marker
 * even though it's absent from `values`.
 */
function LlmReference({
  llmValues,
  propKey,
  issue
}: {
  llmValues: EvalValues | null
  propKey: string
  issue?: EvalIssue
}) {
  const scored = !!llmValues && propKey in llmValues
  if (!scored && issue?.action !== 'dropped') return null

  if (issue?.action === 'dropped') {
    return (
      <LlmLine>
        <span>LLM: — (dropped)</span>
        <IssueMark title={`Model returned ${formatEvalValue(issue.original)}, which couldn't be validated against this property, so it was left unscored.`} />
      </LlmLine>
    )
  }

  const value = formatEvalValue(llmValues![propKey])
  const repaired = issue && (issue.action === 'clamped' || issue.action === 'coerced')
  return (
    <LlmLine>
      <span>LLM: {value}</span>
      {repaired ? (
        <IssueMark title={`Model returned ${formatEvalValue(issue!.original)}; automatically ${issue!.action} to ${value} to fit this property.`} />
      ) : null}
    </LlmLine>
  )
}

function LlmLine({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink/40">
      {children}
    </div>
  )
}

/** A ⚠ badge whose hover/focus reveals what the automatic repair did (the pre-repair `original`). */
function IssueMark({ title }: { title: string }) {
  return (
    <span
      tabIndex={0}
      title={title}
      aria-label={title}
      className="cursor-help border border-ink px-1 font-bold text-ink outline-none focus-visible:bg-ink focus-visible:text-paper"
    >
      ⚠
    </span>
  )
}

function Field({ p, value, onSet }: { p: EvalProperty; value: EvalValue | undefined; onSet: (v: EvalValue | undefined) => void }) {
  // Multi-select enum → toggle chips (empty array clears to "unscored").
  if (p.type === 'enum' && p.multiple) {
    const arr = Array.isArray(value) ? (value as string[]) : []
    const toggle = (o: string) => {
      const next = arr.includes(o) ? arr.filter((x) => x !== o) : [...arr, o]
      onSet(next.length ? next : undefined)
    }
    return (
      <div className="flex flex-wrap gap-2">
        {(p.options ?? []).map((o) => (
          <Seg key={o} active={arr.includes(o)} onClick={() => toggle(o)}>
            {o}
          </Seg>
        ))}
      </div>
    )
  }

  if (p.type === 'enum') {
    return (
      <div className="flex flex-wrap gap-2">
        {(p.options ?? []).map((o) => (
          <Seg key={o} active={value === o} onClick={() => onSet(value === o ? undefined : o)}>
            {o}
          </Seg>
        ))}
      </div>
    )
  }

  if (p.type === 'boolean') {
    return (
      <div className="flex gap-2">
        <Seg active={value === true} onClick={() => onSet(value === true ? undefined : true)}>
          Yes
        </Seg>
        <Seg active={value === false} onClick={() => onSet(value === false ? undefined : false)}>
          No
        </Seg>
      </div>
    )
  }

  if (p.type === 'score') {
    const steps = scoreSteps(p)
    if (steps) {
      return (
        <div className="flex flex-wrap gap-2">
          {steps.map((n) => (
            <Seg key={n} active={value === n} onClick={() => onSet(value === n ? undefined : n)}>
              {n}
            </Seg>
          ))}
        </div>
      )
    }
    return (
      <Input
        type="number"
        className="w-28"
        min={p.min}
        max={p.max}
        step={p.step}
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '') return onSet(undefined)
          const n = Number(raw)
          // Clamp/snap to the property's range client-side so the optimistic value matches what
          // comes back. The server re-clamps in `postResult` and returns a session snapshot holding
          // the persisted file, so skipping this would show the raw number and then visibly correct
          // it when the response lands. The server's pass is the authoritative one either way.
          onSet(Number.isFinite(n) ? clampScore(n, p) : undefined)
        }}
      />
    )
  }

  // text
  return (
    <Textarea
      className="h-20 text-xs"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onSet(e.target.value === '' ? undefined : e.target.value)}
    />
  )
}

/** A segmented toggle button (neo-brutalist: inverts when active). */
function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'min-w-[2.5rem] border-2 border-ink px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-wide transition-colors',
        active ? 'bg-ink text-paper' : 'bg-paper text-ink hover:bg-ink/10'
      )}
    >
      {children}
    </button>
  )
}
