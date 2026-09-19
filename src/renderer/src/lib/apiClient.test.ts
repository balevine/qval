import { describe, expect, it } from 'vitest'
import { createApiClient } from '@/lib/apiClient'
import type { EvalFile, SessionSnapshot, Settings } from '@shared/types'
import { withDefaults } from '@lib/settings.mjs'

/** One recorded call, so a test can assert on the wire and not just the return value. */
interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

const SETTINGS: Settings = withDefaults({})

const WORKING_FILE = {
  meta: {
    app: 'qval',
    appVersion: '0.1.0',
    createdAt: 'now',
    updatedAt: 'now',
    dataset: { fingerprint: 'd', ticketCount: 0, source: null },
    config: { fingerprint: 'c', schema: [], rules: '' }
  },
  evaluators: []
} satisfies EvalFile

const SESSION: SessionSnapshot = {
  tickets: [],
  workingFile: WORKING_FILE,
  workingPath: '/tmp/x.qval.json',
  comparisons: [],
  candidates: [{ id: 'c1', name: 'alice.qval.json', merged: false }]
}

const SESSION_PAYLOAD = { appVersion: '9.9.9', settings: SETTINGS, session: SESSION }

/**
 * A client over a scripted fetch. `responses` maps a pathname to the JSON (and status) it answers
 * with; anything unmapped 404s, which is how a test proves a request was *not* made somewhere else.
 */
function harness(responses: Record<string, { status?: number; json: unknown }>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    })
    const hit = responses[new URL(url, 'http://127.0.0.1').pathname]
    const status = hit?.status ?? (hit ? 200 : 404)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (hit ? hit.json : { error: 'Not found.' })
    } as unknown as Response
  }) as typeof fetch

  const api = createApiClient({ token: 'tok', fetchImpl })
  return { api, calls }
}

const sessionOnly = { '/api/session': { json: SESSION_PAYLOAD } }

describe('reads', () => {
  it('serves settings, the session, and the version off GET /api/session', async () => {
    const { api, calls } = harness(sessionOnly)

    expect(await api.settings.get()).toEqual(SETTINGS)
    expect(await api.session.loadLast()).toEqual(SESSION)
    expect(await api.app.getVersion()).toBe('9.9.9')

    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET'])
    expect(calls[0].url).toBe('/api/session')
  })

  it('sends the session token on every request', async () => {
    const { api, calls } = harness(sessionOnly)
    await api.settings.get()
    expect(calls[0].headers['X-Qval-Token']).toBe('tok')
  })

  it('reports where the working file already is instead of saving', async () => {
    const { api, calls } = harness(sessionOnly)
    expect(await api.session.save()).toBe('/tmp/x.qval.json')
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('returns null from loadLast when no session is bound', async () => {
    const { api } = harness({ '/api/session': { json: { ...SESSION_PAYLOAD, session: null } } })
    expect(await api.session.loadLast()).toBeNull()
    expect(await api.session.save()).toBeNull()
  })
})

describe('settings.set', () => {
  it('posts the three fields the server accepts', async () => {
    const next = { ...SETTINGS, rules: 'be kind' }
    const { api, calls } = harness({ '/api/config': { json: { settings: next, session: SESSION } } })

    expect(await api.settings.set({ rules: 'be kind', evaluatorName: 'Ada' })).toEqual(next)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('/api/config')
    expect(calls[0].body).toEqual({ rules: 'be kind', evaluatorName: 'Ada' })
  })

  it('drops the fields the server will not take', async () => {
    const { api, calls } = harness({ '/api/config': { json: { settings: SETTINGS, session: SESSION } } })
    await api.settings.set({ schema: [], lastDatasetPath: '/etc/passwd' })
    expect(calls[0].body).toEqual({ schema: [] })
  })

  it('re-reads rather than posting an empty patch', async () => {
    const { api, calls } = harness(sessionOnly)
    expect(await api.settings.set({ lastDatasetPath: '/somewhere' })).toEqual(SETTINGS)
    expect(calls.map((c) => c.url)).toEqual(['/api/session'])
  })
})

describe('human.setValues', () => {
  it('posts the ticket id and values to /api/result', async () => {
    const { api, calls } = harness({ '/api/result': { json: { session: SESSION } } })
    await api.human.setValues(7, { empathy: 4 })
    expect(calls[0]).toMatchObject({
      url: '/api/result',
      method: 'POST',
      body: { ticketId: 7, values: { empathy: 4 } }
    })
    expect(calls[0].headers['Content-Type']).toBe('application/json')
  })
})

describe('errors', () => {
  it('surfaces the server sentence', async () => {
    const { api } = harness({ '/api/result': { status: 409, json: { error: 'No working file is open.' } } })
    await expect(api.human.setValues(1, {})).rejects.toThrow('No working file is open.')
  })

  it('falls back to the status code when there is no sentence', async () => {
    const { api } = harness({ '/api/session': { status: 500, json: null } })
    await expect(api.settings.get()).rejects.toThrow('Request failed (500).')
  })
})

describe('merge, export, and done', () => {
  // The point of all three: a body that names an id, or nothing at all. Never a path — the CLI
  // resolved those before the browser existed.
  it('merges and un-merges a candidate by id', async () => {
    const merged: SessionSnapshot = { ...SESSION, candidates: [{ id: 'c1', name: 'alice.qval.json', merged: true }] }
    const { api, calls } = harness({ '/api/comparison': { json: { session: merged } } })

    expect(await api.session.mergeComparison('c1')).toEqual(merged)
    await api.session.unmergeComparison('c1')

    expect(calls.map((c) => c.body)).toEqual([
      { id: 'c1', merge: true },
      { id: 'c1', merge: false }
    ])
    expect(calls.every((c) => c.method === 'POST' && c.url === '/api/comparison')).toBe(true)
  })

  it('exports with an empty body and reports where the server put it', async () => {
    const { api, calls } = harness({ '/api/export': { json: { path: '/tmp/x.report.json' } } })
    expect(await api.session.exportReport()).toBe('/tmp/x.report.json')
    expect(calls[0]).toMatchObject({ url: '/api/export', method: 'POST', body: {} })
  })

  it('ends the session through /api/done', async () => {
    const { api, calls } = harness({ '/api/done': { json: { ok: true, workingPath: '/tmp/x.qval.json' } } })
    await api.review.done()
    expect(calls[0]).toMatchObject({ url: '/api/done', method: 'POST' })
  })
})
