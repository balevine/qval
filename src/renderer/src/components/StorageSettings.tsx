import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSettings } from '@/state/SettingsContext'
import { useSession } from '@/state/SessionContext'

/**
 * Who you are when your scores are saved, plus where they are going.
 *
 * The folder picker is gone with the native dialogs: the CLI resolves both files before the browser
 * exists (spec §19), so the only thing left to choose here is the display name, and the paths are
 * shown rather than set.
 */
export function StorageSettings() {
  const { settings, update } = useSettings()
  const { session } = useSession()
  if (!settings) return null

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label>Your name (evaluator)</Label>
        <Input
          value={settings.evaluatorName}
          placeholder="e.g. Brian L."
          onChange={(e) => update({ evaluatorName: e.target.value })}
        />
        <p className="text-[11px] text-ink/50">
          Stamped on your human evaluations — shown as your column when eval files are merged.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Working file</Label>
        <div className="border-2 border-ink bg-paper px-3 py-2">
          <span className="break-all font-mono text-xs text-ink">{session?.workingPath ?? 'unsaved'}</span>
        </div>
        <p className="text-[11px] text-ink/50">
          Bound by <span className="font-mono">/qval:review</span> when it started. Every edit is written to it
          as you make it — there is nothing to save.
        </p>
      </div>
    </div>
  )
}
