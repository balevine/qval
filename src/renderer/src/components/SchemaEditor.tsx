import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useSettings } from '@/state/SettingsContext'
import { useSession } from '@/state/SessionContext'
import { LockNotice } from '@/components/ui/lock-notice'
import { HelpTooltip } from '@/components/ui/help-tooltip'
import { allowsMultiple, blankProperty, schemaErrors, toCamelKey } from '@lib/schema.mjs'
import { configLocked } from '@lib/evalFile.mjs'
import { cn } from '@/lib/utils'
import type { EvalProperty, PropertyType } from '@shared/types'

const TYPES: { value: PropertyType; label: string }[] = [
  { value: 'score', label: 'Score' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'enum', label: 'Enum' },
  { value: 'text', label: 'Text' }
]

/** Local editor row: a property plus transient UI state (stable id, whether the key was hand-edited). */
interface EditorRow {
  uid: number
  prop: EvalProperty
  keyEdited: boolean
}

function cloneProp(p: EvalProperty): EvalProperty {
  return { ...p, options: p.options ? [...p.options] : undefined }
}

/**
 * The ordered, editable list of typed output properties. Local draft state is
 * authoritative while the tab is open; each change persists the schema to settings (main
 * normalizes it). Inline validation is advisory. Invalid rows simply aren't persisted.
 *
 * Under the `jev` scorer only the label, key, description, and order are editable. Type, options,
 * multiple, and the score bounds are fixed, and properties cannot be added or removed. A Jev
 * property carries option definitions keyed by option and a score scale whose bounds are its level
 * count, so editing any of those here would leave definitions describing answers that no longer
 * exist, and a new row would have no question at all. A Jev schema is written by drafting or by
 * hand in `EVAL_SCHEMA.json`. The Jev fields themselves ride along untouched on every save.
 */
export function SchemaEditor() {
  const { settings, update } = useSettings()
  const { session } = useSession()
  const locked = configLocked(session?.workingFile)
  const jev = settings?.scorer === 'jev'
  const [rows, setRows] = useState<EditorRow[] | null>(null)
  const nextUid = useRef(0)

  // Seed the draft from settings once, when it first becomes available.
  useEffect(() => {
    if (settings && rows === null) {
      setRows(settings.schema.map((p) => ({ uid: nextUid.current++, prop: cloneProp(p), keyEdited: true })))
    }
  }, [settings, rows])

  if (!settings || rows === null) return null

  const commit = (next: EditorRow[]) => {
    setRows(next)
    update({ schema: next.map((r) => r.prop) })
  }

  const patchRow = (uid: number, fn: (row: EditorRow) => EditorRow) =>
    commit(rows.map((r) => (r.uid === uid ? fn(r) : r)))

  const setLabel = (uid: number, label: string) =>
    patchRow(uid, (r) => ({
      ...r,
      prop: { ...r.prop, label, key: r.keyEdited ? r.prop.key : toCamelKey(label) }
    }))

  const setKey = (uid: number, key: string) =>
    patchRow(uid, (r) => ({ ...r, keyEdited: true, prop: { ...r.prop, key: key.trim() } }))

  const setType = (uid: number, type: PropertyType) =>
    patchRow(uid, (r) => {
      // Reset type-specific fields, keep the shared ones (label/key/description).
      const fresh = blankProperty(type)
      const prop: EvalProperty = {
        ...fresh,
        key: r.prop.key,
        label: r.prop.label,
        description: r.prop.description,
        multiple: allowsMultiple(type) ? r.prop.multiple : undefined
      }
      return { ...r, prop }
    })

  const setField = (uid: number, patch: Partial<EvalProperty>) =>
    patchRow(uid, (r) => ({ ...r, prop: { ...r.prop, ...patch } }))

  const setOption = (uid: number, idx: number, value: string) =>
    patchRow(uid, (r) => {
      const options = [...(r.prop.options ?? [])]
      options[idx] = value
      return { ...r, prop: { ...r.prop, options } }
    })

  const addOption = (uid: number) =>
    patchRow(uid, (r) => ({ ...r, prop: { ...r.prop, options: [...(r.prop.options ?? []), ''] } }))

  const removeOption = (uid: number, idx: number) =>
    patchRow(uid, (r) => ({
      ...r,
      prop: { ...r.prop, options: (r.prop.options ?? []).filter((_, i) => i !== idx) }
    }))

  const addRow = () =>
    commit([...rows, { uid: nextUid.current++, prop: blankProperty('score'), keyEdited: false }])

  const removeRow = (uid: number) => commit(rows.filter((r) => r.uid !== uid))

  const move = (uid: number, dir: -1 | 1) => {
    const i = rows.findIndex((r) => r.uid === uid)
    const j = i + dir
    if (j < 0 || j >= rows.length) return
    const next = [...rows]
    ;[next[i], next[j]] = [next[j], next[i]]
    commit(next)
  }

  // Whole-schema validation, because under Jev the question text (instructions plus description)
  // must differ between rows, and editing a description can make two of them collide.
  const rowErrors = schemaErrors(
    rows.map((r) => r.prop),
    settings.scorer
  )

  return (
    <div className="space-y-3">
      {jev && !locked ? (
        <div className="flex items-center justify-between gap-3 border-2 border-ink bg-ink/5 px-3 py-2">
          <p className="font-mono text-[11px] text-ink/70">
            Jev schema. Type, options, and scale are fixed here.
          </p>
          <HelpTooltip label="About editing a Jev schema">
            A Jev property carries definitions for each option and a named scale for each score, and this editor
            does not edit those. Changing a type, an option, or a range here would leave them describing answers
            that no longer exist, so only the label, key, description, and order can change. To change the rest,
            draft again with <span className="font-mono">/qval:draft</span> or edit{' '}
            <span className="font-mono">EVAL_SCHEMA.json</span> by hand before starting a review.
          </HelpTooltip>
        </div>
      ) : null}
      {locked ? (
        <LockNotice>
          Schema is locked. This file already has evaluations, so its scoring criteria are frozen to keep every
          score comparable. Scoring the same tickets under a different schema means a new eval file. Run{' '}
          <span className="font-mono">/qval:evaluate-tickets</span> with{' '}
          <span className="font-mono">--eval-file &lt;new path&gt;</span>.
        </LockNotice>
      ) : null}
      <fieldset disabled={locked} className={cn('m-0 space-y-3 border-0 p-0', locked && 'opacity-60')}>
      {rows.map((row, i) => {
        const p = row.prop
        const errors = rowErrors[i] ?? []
        return (
          <div key={row.uid} className="border-2 border-ink">
            {/* Row header: label · key · reorder/remove */}
            <div className="flex items-end gap-2 border-b-2 border-ink bg-ink/5 px-2 py-2">
              <label className="flex-1">
                <Caption>Label · display name</Caption>
                <Input
                  aria-label="Label"
                  placeholder="e.g. Empathy"
                  value={p.label}
                  onChange={(e) => setLabel(row.uid, e.target.value)}
                />
              </label>
              <label className="w-40">
                <Caption>Key · id in data</Caption>
                <Input
                  aria-label="Key"
                  placeholder="empathy"
                  value={p.key}
                  onChange={(e) => setKey(row.uid, e.target.value)}
                  className="font-mono text-xs"
                />
              </label>
              <IconButton aria-label="Move up" disabled={i === 0} onClick={() => move(row.uid, -1)}>
                <ChevronUp className="h-4 w-4" />
              </IconButton>
              <IconButton aria-label="Move down" disabled={i === rows.length - 1} onClick={() => move(row.uid, 1)}>
                <ChevronDown className="h-4 w-4" />
              </IconButton>
              {jev ? null : (
                <IconButton aria-label="Remove property" onClick={() => removeRow(row.uid)}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              )}
            </div>

            <div className="space-y-3 px-3 py-3">
              {/* Type + multiple */}
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label className="text-[10px]">Type</Label>
                  <Select value={p.type} disabled={jev} onValueChange={(v) => setType(row.uid, v as PropertyType)}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {allowsMultiple(p.type) ? (
                  <label className="flex items-center gap-2">
                    <Switch
                      disabled={jev}
                      checked={!!p.multiple}
                      onCheckedChange={(checked) => setField(row.uid, { multiple: checked || undefined })}
                      aria-label="Allow multiple"
                    />
                    <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink/70">
                      Allow multiple (array)
                    </span>
                  </label>
                ) : null}
              </div>

              {/* Score bounds */}
              {p.type === 'score' && p.levels ? (
                <div className="space-y-1">
                  <Label className="text-[10px]">Levels · lowest first</Label>
                  <div className="flex flex-wrap gap-2">
                    {p.levels.map((l, idx) => (
                      <span
                        key={idx}
                        title={l.description}
                        className="border-2 border-ink px-2 py-1 font-mono text-xs text-ink/70"
                      >
                        {idx} · {l.label}
                      </span>
                    ))}
                  </div>
                </div>
              ) : p.type === 'score' ? (
                <div className="flex items-center gap-3">
                  <NumField label="Min" disabled={jev} value={p.min} onChange={(n) => setField(row.uid, { min: n })} />
                  <NumField label="Max" disabled={jev} value={p.max} onChange={(n) => setField(row.uid, { max: n })} />
                  <NumField label="Step" disabled={jev} value={p.step} onChange={(n) => setField(row.uid, { step: n })} />
                </div>
              ) : null}

              {/* Enum options */}
              {p.type === 'enum' ? (
                <div className="space-y-2">
                  <Label className="text-[10px]">Options</Label>
                  <div className="flex flex-wrap gap-2">
                    {(p.options ?? []).map((opt, idx) => (
                      <div key={idx} className="flex items-center border-2 border-ink">
                        <input
                          aria-label={`Option ${idx + 1}`}
                          value={opt}
                          readOnly={jev}
                          title={p.optionDescriptions?.[opt]}
                          onChange={(e) => setOption(row.uid, idx, e.target.value)}
                          className={cn('w-28 bg-paper px-2 py-1 font-mono text-xs focus:outline-none', jev && 'text-ink/70')}
                        />
                        {jev ? null : (
                          <button
                            type="button"
                            aria-label="Remove option"
                            onClick={() => removeOption(row.uid, idx)}
                            className="border-l-2 border-ink px-1 py-1 hover:bg-ink hover:text-paper"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                    {jev ? null : (
                      <Button size="sm" variant="outline" onClick={() => addOption(row.uid)}>
                        <Plus className="h-3.5 w-3.5" />
                        Option
                      </Button>
                    )}
                  </div>
                </div>
              ) : null}

              {/* The Jev question, shown so the description can be read beside it. Not edited here. */}
              {p.instructions ? (
                <div>
                  <Caption>Question · asked of Jev</Caption>
                  <p className="text-xs text-ink/80">{p.instructions}</p>
                </div>
              ) : null}

              {/* Description */}
              <label className="block">
                <Caption>
                  {jev ? 'Description · part of the Jev question, shown to the human' : 'Description · shown to the human + the LLM'}
                </Caption>
                <Input
                  aria-label="Description"
                  placeholder="e.g. How well the agent acknowledged the customer’s feelings."
                  value={p.description ?? ''}
                  onChange={(e) => setField(row.uid, { description: e.target.value || undefined })}
                />
              </label>

              {errors.length > 0 ? (
                <ul className="border-l-[6px] border-ink pl-3">
                  {errors.map((err) => (
                    <li key={err} className="font-mono text-[11px] text-ink/70">
                      {err}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        )
      })}

      {jev ? null : (
        <Button variant="outline" onClick={addRow}>
          <Plus className="h-4 w-4" />
          Add property
        </Button>
      )}
      </fieldset>
    </div>
  )
}

/** Tiny field caption above an input. */
function Caption({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-ink/45">
      {children}
    </span>
  )
}

/** A small labeled numeric input for score bounds. */
function NumField({
  label,
  value,
  disabled,
  onChange
}: {
  label: string
  value?: number
  disabled?: boolean
  onChange: (n: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Label className="text-[10px]">{label}</Label>
      <Input
        type="number"
        aria-label={label}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-20"
      />
    </div>
  )
}
