// The one HTTP call Qval makes itself: a Jev request to Typesafe's systemone endpoint.
//
// The key comes from one environment variable and nowhere else. There is no keychain, no settings
// field, and no server endpoint that takes it, so the only place it exists is the process that
// sends the request. It is never part of a request body, only the Authorization header.
//
// Only 408, 429, and 5xx are sent again (529 is Typesafe's "overloaded"). Everything else is an
// answer about the request itself, and repeating it would only get the same answer back. At most
// two retries, after a fixed short wait, or after what `retry-after` asks for when it asks.
//
// Nothing here reads an error body for meaning. It is carried raw into the error, with the key cut
// out first, in case the API ever echoes the Authorization header back in a failure.

/** The endpoint. Fixed, since there is one service and nothing to configure. */
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'

/** The only place the key is read from. */
export const KEY_VARIABLE = 'TYPESAFE_API_KEY'

export const REQUEST_TIMEOUT_MS = 30_000
export const MAX_RETRIES = 2
export const RETRY_DELAY_MS = 1_000
/** The longest `retry-after` is waited out. A longer ask is held to this rather than obeyed, so one
 *  rate limit cannot stall a background run for minutes before the retries are spent. */
export const LONGEST_RETRY_AFTER_MS = 30_000

/** How much of an error body goes in the message. Bodies are rarely long, but a proxy's HTML is. */
const BODY_EXCERPT_CHARS = 500

const HINTS = {
  401: `Check ${KEY_VARIABLE}.`,
  403: `Check ${KEY_VARIABLE}.`,
  429: 'That is the rate limit, and the retries are spent.'
}

/**
 * The key, trimmed, or null when the variable is unset or blank. Trimming matters because a key
 * pasted into a shell profile often carries a trailing newline or space, and the API would refuse it.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function apiKeyFromEnv(env = process.env) {
  const key = (env[KEY_VARIABLE] ?? '').trim()
  return key ? key : null
}

/**
 * `text` with every occurrence of `key` replaced. Safe only because the key is never empty here:
 * splitting on an empty string would break the text apart at every character.
 * @param {string} text
 * @param {string} key
 * @returns {string}
 */
export function redactKey(text, key) {
  return key ? String(text).split(key).join('[redacted]') : String(text)
}

/** A request that did not come back with a usable body. `body` is already redacted. */
export class TypesafeError extends Error {
  /**
   * @param {string} message already redacted
   * @param {number} status 0 when no response arrived at all
   * @param {string} body already redacted
   */
  constructor(message, status, body) {
    super(message)
    this.name = 'TypesafeError'
    this.status = status
    this.body = body
  }
}

/**
 * Whether a status is worth sending the same request again.
 * @param {number} status
 * @returns {boolean}
 */
export function retryable(status) {
  return status === 408 || status === 429 || status >= 500
}

/**
 * How long to wait before the next attempt: what `retry-after` asks (seconds, or an HTTP date),
 * held to `LONGEST_RETRY_AFTER_MS`, else the fixed delay.
 * @param {{ get(name: string): string | null }} headers
 * @param {number} [nowMs]
 * @returns {number} milliseconds
 */
export function retryDelayMs(headers, nowMs = Date.now()) {
  const raw = headers.get('retry-after')
  if (raw !== null && raw.trim() !== '') {
    const seconds = Number(raw.trim())
    const asked = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - nowMs
    if (Number.isFinite(asked) && asked >= 0) return Math.min(asked, LONGEST_RETRY_AFTER_MS)
  }
  return RETRY_DELAY_MS
}

function failure(status, body, key, problem) {
  const clean = redactKey(body, key)
  const parts = [problem ? redactKey(problem, key) : `Typesafe answered ${status}.`]
  if (HINTS[status]) parts.push(HINTS[status])
  const excerpt = clean.trim().slice(0, BODY_EXCERPT_CHARS)
  if (excerpt) parts.push(excerpt)
  return new TypesafeError(parts.join(' '), status, clean)
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Send one Jev request and return the response body, parsed. Throws `TypesafeError` with the key
 * removed from everything it carries.
 * @param {unknown} body the request, which never contains the key
 * @param {object} options
 * @param {string} options.key
 * @param {typeof fetch} [options.fetch] injectable for tests. Read at call time, not import time.
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable so a test does not wait
 * @param {number} [options.timeoutMs]
 * @param {string} [options.url]
 * @returns {Promise<unknown>}
 */
export async function postSystemOne(body, options) {
  const { key } = options
  const doFetch = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? realSleep
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const url = options.url ?? TYPESAFE_URL
  const payload = JSON.stringify(body)

  for (let tries = 0; ; tries++) {
    let response
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      // A timeout is not retried: the request may well have been processed, and the response
      // cache makes a later `--resume` cheap. The error's own message is not carried, since some
      // runtimes put the request (headers included) into it.
      const name = err && typeof err === 'object' && typeof err.name === 'string' ? err.name : 'Error'
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw failure(0, '', key, `Typesafe did not answer within ${Math.round(timeoutMs / 1000)}s.`)
      }
      throw failure(0, '', key, `Typesafe could not be reached (${name}).`)
    }

    const text = await response.text()
    if (response.ok) {
      try {
        return JSON.parse(text)
      } catch {
        throw failure(response.status, text, key, `Typesafe answered ${response.status} with a body that is not JSON.`)
      }
    }
    if (tries >= MAX_RETRIES || !retryable(response.status)) throw failure(response.status, text, key)
    await sleep(retryDelayMs(response.headers))
  }
}
