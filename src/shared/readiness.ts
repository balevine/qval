import type { Settings } from './types'

export interface Readiness {
  ready: boolean
  message: string
}

/**
 * Whether the active provider is configured enough to run an evaluation, with a message pointing
 * the user at what's missing. Ollama needs a model; Anthropic needs a saved key + a chosen model.
 */
export function evaluationReadiness(settings: Settings, hasKey: boolean): Readiness {
  if (settings.providerId === 'ollama') {
    return settings.ollama.model.trim()
      ? { ready: true, message: '' }
      : { ready: false, message: 'Select an Ollama model in Settings → Provider.' }
  }
  if (!hasKey) return { ready: false, message: 'Add an Anthropic API key in Settings → Provider.' }
  if (!settings.anthropic.model) return { ready: false, message: 'Choose an Anthropic model in Settings → Provider.' }
  return { ready: true, message: '' }
}
