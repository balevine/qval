import { describe, it, expect } from 'vitest'

import {
  KEY_VARIABLE,
  LONGEST_RETRY_AFTER_MS,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  TYPESAFE_URL,
  TypesafeError,
  apiKeyFromEnv,
  postSystemOne,
  redactKey,
  retryDelayMs,
  retryable
} from '@lib/typesafe.mjs'

const KEY = 'ts-secret-key-123'

/** A fetch that answers from a script, one reply per call, and records what it was sent. */
function scripted(replies: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const next = replies[Math.min(calls.length - 1, replies.length - 1)]
    return next()
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })

/** For the failure cases: a request that resolves is itself the test failing. */
const unexpected = (): TypesafeError => {
  throw new Error('expected the request to fail')
}

function sleeps() {
  const waited: number[] = []
  return { waited, sleep: async (ms: number) => void waited.push(ms) }
}

describe('apiKeyFromEnv', () => {
  it('reads only the one variable, trimmed, and treats blank as missing', () => {
    expect(apiKeyFromEnv({ [KEY_VARIABLE]: `  ${KEY}\n` })).toBe(KEY)
    expect(apiKeyFromEnv({ [KEY_VARIABLE]: '   ' })).toBeNull()
    expect(apiKeyFromEnv({})).toBeNull()
    expect(apiKeyFromEnv({ OPENROUTER_API_KEY: KEY })).toBeNull()
  })
})

describe('redactKey', () => {
  it('removes every occurrence, and leaves text alone without a key', () => {
    expect(redactKey(`a ${KEY} b ${KEY}`, KEY)).toBe('a [redacted] b [redacted]')
    expect(redactKey('abc', '')).toBe('abc')
  })
})

describe('retry policy', () => {
  it('retries 408, 429, and 5xx only', () => {
    expect([408, 429, 500, 503, 529].every(retryable)).toBe(true)
    expect([400, 401, 403, 404, 422].some(retryable)).toBe(false)
  })

  it('honors retry-after in seconds or as a date, held to the cap', () => {
    const h = (v?: string) => new Headers(v === undefined ? {} : { 'retry-after': v })
    expect(retryDelayMs(h())).toBe(RETRY_DELAY_MS)
    expect(retryDelayMs(h('2'))).toBe(2000)
    expect(retryDelayMs(h('3600'))).toBe(LONGEST_RETRY_AFTER_MS)
    expect(retryDelayMs(h('nonsense'))).toBe(RETRY_DELAY_MS)
    const now = Date.parse('2026-10-06T00:00:00Z')
    expect(retryDelayMs(h('Tue, 06 Oct 2026 00:00:05 GMT'), now)).toBe(5000)
  })
})

describe('postSystemOne', () => {
  it('posts the body with the key in the header only, and returns the parsed answer', async () => {
    const { fetch, calls } = scripted([json(200, { model: 'jev-1.13', answers: {} })])
    const out = await postSystemOne({ model: 'jev-latest', questions: {} }, { key: KEY, fetch })
    expect(out).toEqual({ model: 'jev-1.13', answers: {} })
    expect(calls[0].url).toBe(TYPESAFE_URL)
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
    expect(String(calls[0].init.body)).not.toContain(KEY)
  })

  it('retries a 429 then a 529 and succeeds, waiting what retry-after asked', async () => {
    const { fetch, calls } = scripted([
      json(429, 'slow down', { 'retry-after': '2' }),
      json(529, 'overloaded'),
      json(200, { answers: {} })
    ])
    const { waited, sleep } = sleeps()
    await expect(postSystemOne({}, { key: KEY, fetch, sleep })).resolves.toEqual({ answers: {} })
    expect(calls).toHaveLength(3)
    expect(waited).toEqual([2000, RETRY_DELAY_MS])
  })

  it('gives up after two retries, and never retries a client error', async () => {
    const busy = scripted([json(503, 'down')])
    const { waited, sleep } = sleeps()
    const err = await postSystemOne({}, { key: KEY, fetch: busy.fetch, sleep }).then(unexpected, (e: TypesafeError) => e)
    expect(err).toBeInstanceOf(TypesafeError)
    expect(err.status).toBe(503)
    expect(busy.calls).toHaveLength(MAX_RETRIES + 1)
    expect(waited).toHaveLength(MAX_RETRIES)

    const bad = scripted([json(422, { detail: 'criteria must have 2 levels' })])
    const e422 = await postSystemOne({}, { key: KEY, fetch: bad.fetch, sleep }).then(unexpected, (e: TypesafeError) => e)
    expect(bad.calls).toHaveLength(1)
    expect(e422.message).toContain('Typesafe answered 422.')
    expect(e422.message).toContain('criteria must have 2 levels')
  })

  it('never lets the key out of an error body', async () => {
    const echo = `{"error":"invalid key","received":"Bearer ${KEY}"}`
    const { fetch } = scripted([json(401, echo)])
    const err = await postSystemOne({}, { key: KEY, fetch }).then(unexpected, (e: TypesafeError) => e)
    expect(err.status).toBe(401)
    expect(err.message).not.toContain(KEY)
    expect(err.body).not.toContain(KEY)
    expect(err.message).toContain('[redacted]')
    expect(err.message).toContain(KEY_VARIABLE)
    expect(JSON.stringify(err)).not.toContain(KEY)
    expect(String(err.stack)).not.toContain(KEY)
  })

  it('reports a body that is not JSON, redacted', async () => {
    const { fetch } = scripted([json(200, `<html>${KEY}</html>`)])
    const err = await postSystemOne({}, { key: KEY, fetch }).then(unexpected, (e: TypesafeError) => e)
    expect(err.message).toMatch(/not JSON/)
    expect(err.message).not.toContain(KEY)
  })

  it('times out a request that never answers, without retrying it', async () => {
    let calls = 0
    const fetch = ((_url: string, init: RequestInit) => {
      calls++
      return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))
    }) as unknown as typeof globalThis.fetch
    const err = await postSystemOne({}, { key: KEY, fetch, timeoutMs: 20 }).then(unexpected, (e: TypesafeError) => e)
    expect(err).toBeInstanceOf(TypesafeError)
    expect(err.status).toBe(0)
    expect(err.message).toMatch(/did not answer within/)
    expect(calls).toBe(1)
  })

  it('names an unreachable host without carrying the transport error text', async () => {
    const fetch = (async () => {
      throw new TypeError(`fetch failed: Bearer ${KEY}`)
    }) as unknown as typeof globalThis.fetch
    const err = await postSystemOne({}, { key: KEY, fetch }).then(unexpected, (e: TypesafeError) => e)
    expect(err.message).toBe('Typesafe could not be reached (TypeError).')
  })
})
