import { useMemo, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SectionHeader } from '@/components/ui/section-header'
import { useSettings } from '@/state/SettingsContext'
import { useSession } from '@/state/SessionContext'
import { LockNotice } from '@/components/ui/lock-notice'
import { compilePrompt, SAMPLE_PREVIEW_TICKETS } from '@shared/promptCompiler'
import { configLocked } from '@shared/evalFile'
import { cn } from '@/lib/utils'

/**
 * Free-form rules editor (spec §2.3/§4) plus a compiled-prompt preview. The preview runs the
 * pure prompt compiler over a sample ticket so the user sees exactly what the LLM will receive
 * (rules + schema spec + output contract + a rendered ticket).
 */
export function RulesEditor() {
  const { settings, update } = useSettings()
  const { session } = useSession()
  const locked = configLocked(session?.workingFile)
  const [showPreview, setShowPreview] = useState(false)

  const compiled = useMemo(
    () =>
      settings
        ? compilePrompt({ rules: settings.rules, schema: settings.schema, tickets: SAMPLE_PREVIEW_TICKETS })
        : null,
    [settings]
  )

  if (!settings || !compiled) return null

  return (
    <div className="space-y-3">
      {locked ? (
        <LockNotice>
          Rules are locked — this file already has evaluations, so its scoring guidance is frozen.{' '}
          <span className="font-bold text-ink">Open</span> its tickets.json to start a fresh evaluation with
          different rules. (You can still preview.)
        </LockNotice>
      ) : null}
      <Textarea
        value={settings.rules}
        disabled={locked}
        onChange={(e) => {
          update({ rules: e.target.value })
          // Hide the preview on edit so the user never sees stale compiled output; they re-open
          // it to recompile against the latest rules.
          if (showPreview) setShowPreview(false)
        }}
        className={cn('h-56 font-mono text-xs', locked && 'opacity-60')}
        spellCheck={false}
        aria-label="Rules"
      />

      <Button size="sm" variant="outline" onClick={() => setShowPreview((v) => !v)}>
        {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        {showPreview ? 'Hide' : 'Preview'} compiled prompt
      </Button>

      {showPreview ? (
        <div className="border-2 border-ink">
          <SectionHeader title="Compiled prompt · sample ticket" />
          <div className="max-h-72 overflow-auto bg-paper p-3">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink/40">System</div>
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink/80">
              {compiled.system}
            </pre>
            <div className="my-2 border-t-2 border-ink/10 pt-2 font-mono text-[10px] uppercase tracking-widest text-ink/40">
              User message
            </div>
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink">
              {compiled.full}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  )
}
