import type { EvalFile, Settings } from './types'
import { llmRunBlockReason } from './evalFile'

export interface Readiness {
  ready: boolean
  message: string
}

/**
 * Whether an evaluation can run, with a message pointing the user at what's missing. A file scored
 * outside the app (the Claude Code skill) blocks outright, whatever the provider config says.
 * Otherwise Ollama needs a model, and Anthropic a saved key + a chosen model.
 */
export function evaluationReadiness(
  settings: Settings,
  hasKey: boolean,
  file?: EvalFile | null
): Readiness {
  const blocked = llmRunBlockReason(file)
  if (blocked) return { ready: false, message: blocked }
  if (settings.providerId === 'ollama') {
    return settings.ollama.model.trim()
      ? { ready: true, message: '' }
      : { ready: false, message: 'Select an Ollama model in Settings → Provider.' }
  }
  if (!hasKey) return { ready: false, message: 'Add an Anthropic API key in Settings → Provider.' }
  if (!settings.anthropic.model) return { ready: false, message: 'Choose an Anthropic model in Settings → Provider.' }
  return { ready: true, message: '' }
}
