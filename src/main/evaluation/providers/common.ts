import type { ProviderId } from '@shared/types'
import { SYSTEM_PROMPT as EVAL_SYSTEM } from '@shared/promptCompiler'
import { isRetryableStatus, ProviderError } from './types'

/** The evaluator system instruction (shared with the prompt compiler) — cacheable. */
export const SYSTEM_PROMPT = EVAL_SYSTEM

/** Low temperature: scoring should be as consistent as the model allows. */
export const TEMPERATURE = 0.2

/**
 * Total wall-clock cap on a non-streaming hosted request (Anthropic). Generous — beyond any real
 * single-batch generation — so it only fires on a genuinely hung socket, never clips slow work.
 */
export const REQUEST_TIMEOUT_MS = 600_000
/**
 * Idle cap on a streaming request (Ollama): abort if no bytes arrive within this window. Reset on
 * every chunk, so a progressing stream never trips it; only a stalled/dead socket (or an over-long
 * cold model load) does. Generous enough to cover a cold model load.
 */
export const STREAM_IDLE_TIMEOUT_MS = 300_000

export interface Deadline {
  /** Aborts on either the caller's cancel or the timeout; pass to `fetch`. */
  signal: AbortSignal
  /** Restart the timer (for idle timeouts — call on stream activity). */
  reset: () => void
  /** Cancel the timer and detach the cancel listener (call in a `finally`). */
  clear: () => void
  /** True once the timer fired (vs. a caller cancel) — lets adapters raise a retryable timeout. */
  readonly timedOut: boolean
}

/**
 * Combine the caller's cancel signal with a timeout into one abort signal, so a hung socket can't
 * stall a run forever while the user's Cancel still works. The timeout is retryable at the adapter
 * layer; the caller's cancel is not (the orchestrator sees the run signal aborted and stops).
 */
export function withDeadline(signal: AbortSignal | undefined, ms: number): Deadline {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout>
  const arm = () => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, ms)
  }
  const onAbort = () => {
    clearTimeout(timer)
    controller.abort()
  }
  const clear = () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  arm()
  return {
    signal: controller.signal,
    reset: () => {
      clearTimeout(timer)
      arm()
    },
    clear,
    get timedOut() {
      return timedOut
    }
  }
}

/** A hung request that hit its deadline (not a user cancel) — retryable so the run can recover. */
export function timeoutError(provider: ProviderId): ProviderError {
  return new ProviderError(`${provider} request timed out (no response)`, provider, undefined, true)
}

/**
 * POST a JSON body and return the parsed JSON response. Throws a `ProviderError` (with a body
 * snippet + retryable flag) on a non-OK status, or a retryable timeout if the request hangs past
 * `REQUEST_TIMEOUT_MS`. Shared by the non-streaming hosted adapters.
 */
export async function postJson(
  provider: ProviderId,
  url: string,
  init: { headers?: Record<string, string>; body: unknown; signal?: AbortSignal }
): Promise<unknown> {
  const deadline = withDeadline(init.signal, REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify(init.body),
      signal: deadline.signal
    })
    if (!res.ok) throw await errorFromResponse(provider, res)
    return await res.json()
  } catch (err) {
    if (init.signal?.aborted) throw err // user cancel — let the orchestrator stop
    if (deadline.timedOut) throw timeoutError(provider)
    throw err
  } finally {
    deadline.clear()
  }
}

/**
 * Robustly pull a JSON value out of model text: try direct parse, strip ```fences```, then
 * fall back to the first `{`…last `}` slice. Throws if nothing parses.
 */
export function extractJson(text: string): unknown {
  const trimmed = (text ?? '').trim()
  if (!trimmed) throw new Error('Model returned empty output')

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fenced ? fenced[1] : trimmed

  try {
    return JSON.parse(candidate)
  } catch {
    /* fall through */
  }

  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      /* fall through */
    }
  }
  throw new Error('Model did not return valid JSON')
}

/** Build a ProviderError from a non-OK fetch Response, capturing a short body snippet. */
export async function errorFromResponse(provider: ProviderId, res: Response): Promise<ProviderError> {
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 300)
  } catch {
    /* ignore */
  }
  const message = `${provider} responded ${res.status}${detail ? `: ${detail}` : ''}`
  return new ProviderError(message, provider, res.status, isRetryableStatus(res.status))
}
