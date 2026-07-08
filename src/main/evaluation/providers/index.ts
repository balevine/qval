import type { ProviderId, Settings } from '@shared/types'
import { ProviderError, type LLMProvider } from './types'
import { AnthropicProvider } from './anthropic'
import { OllamaProvider } from './ollama'

export * from './types'
export * from './models'

/** The model id that will be used for the given settings (both are user-selected in Qval). */
export function modelForSettings(settings: Settings): string {
  return settings.providerId === 'ollama' ? settings.ollama.model : settings.anthropic.model ?? ''
}

/**
 * Build the active provider adapter. Resolves the user-selected model and the API key
 * (main-process only). Throws a ProviderError when misconfigured.
 */
export async function createProvider(
  settings: Settings,
  getKey: (provider: ProviderId) => Promise<string | null>
): Promise<LLMProvider> {
  const id = settings.providerId

  if (id === 'ollama') {
    if (!settings.ollama.model.trim()) {
      throw new ProviderError('No Ollama model selected. Fetch and choose a model in Settings.', 'ollama')
    }
    return new OllamaProvider(settings.ollama.host, settings.ollama.model)
  }

  const model = settings.anthropic.model
  if (!model) throw new ProviderError('No Anthropic model selected. Fetch and choose one in Settings.', id)
  const key = await getKey(id)
  if (!key) throw new ProviderError(`No API key saved for ${id}. Add one in Settings.`, id)

  return new AnthropicProvider(key, model)
}
