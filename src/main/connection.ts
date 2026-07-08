import type { ConnectionTestResult, ProviderId } from '@shared/types'

const TIMEOUT_MS = 12_000

function withTimeout(): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

/** Normalize a host into a base URL without a trailing slash. */
export function normalizeHost(host: string): string {
  const h = (host || '').trim().replace(/\/+$/, '')
  return h || 'http://localhost:11434'
}

/** List models installed on a local Ollama server via `GET /api/tags`. */
export async function listOllamaModels(host: string): Promise<string[]> {
  const base = normalizeHost(host)
  const { signal, cancel } = withTimeout()
  try {
    const res = await fetch(`${base}/api/tags`, { signal })
    if (!res.ok) throw new Error(`Ollama responded ${res.status}`)
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> }
    const names = (data.models ?? [])
      .map((m) => m.name ?? m.model)
      .filter((n): n is string => typeof n === 'string')
    return Array.from(new Set(names)).sort()
  } finally {
    cancel()
  }
}

/**
 * List the account's available Anthropic models via `GET /v1/models` (the user picks one — unlike
 * Qbort's fixed model). Returns model ids, newest first as the API orders them. The key is read
 * in main and passed here; it never crosses IPC.
 */
export async function listAnthropicModels(key: string): Promise<string[]> {
  const { signal, cancel } = withTimeout()
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal
    })
    if (res.status === 401 || res.status === 403) throw new Error('API key was rejected (unauthorized).')
    if (!res.ok) throw new Error(`Anthropic responded ${res.status}`)
    const data = (await res.json()) as { data?: Array<{ id?: string }> }
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
  } finally {
    cancel()
  }
}

/**
 * Probe a provider to confirm the key/host works. Hosted providers hit a cheap "list models"
 * endpoint; Ollama hits `/api/tags`. Returns a friendly ok/message result rather than throwing.
 */
export async function testConnection(
  provider: ProviderId,
  opts: { host?: string; getKey: (p: ProviderId) => Promise<string | null> }
): Promise<ConnectionTestResult> {
  try {
    if (provider === 'ollama') {
      const models = await listOllamaModels(opts.host ?? '')
      return {
        ok: true,
        message: models.length
          ? `Connected. ${models.length} model(s) available.`
          : 'Connected, but no models are installed. Run `ollama pull <model>`.'
      }
    }

    const key = await opts.getKey(provider)
    if (!key) return { ok: false, message: 'No API key saved for this provider.' }

    const { signal, cancel } = withTimeout()
    try {
      const res = await probeHosted(provider, key, signal)
      if (res.ok) return { ok: true, message: 'Connected. API key is valid.' }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: 'API key was rejected (unauthorized).' }
      }
      return { ok: false, message: `Provider responded ${res.status}.` }
    } finally {
      cancel()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Connection failed: ${message}` }
  }
}

function probeHosted(provider: ProviderId, key: string, signal: AbortSignal): Promise<Response> {
  switch (provider) {
    case 'anthropic':
      return fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal
      })
    default:
      return Promise.reject(new Error(`Unknown hosted provider: ${provider}`))
  }
}
