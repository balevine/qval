/**
 * The renderer's data layer: an `IpcApi` implementation backed by `fetch` against the review server
 * (`plugin/server/server.mjs`, spec §19). It replaces the Electron preload bridge, so the same UI
 * now runs in an ordinary browser tab.
 *
 * Two things shrink here relative to the old bridge, both on purpose.
 *
 * **No paths.** The CLI resolves the tickets.json, the *.qval.json, and the files on offer to merge
 * before the browser exists. So there is no open dialog and no save-as: the session is whatever the
 * CLI bound, merging names a candidate by id, and the report's destination is derived from the
 * working file rather than chosen.
 *
 * **No LLM run.** That moved to `/qval:evaluate-tickets` (spec §18), and the provider, secret, and
 * evaluation members are gone from the contract entirely — there is nothing left to stub.
 */

import type { IpcApi, SessionSnapshot, Settings } from '@shared/types'

/** Query parameter carrying the session token on the first page load (mirrors the server). */
const TOKEN_PARAM = 't'
const TOKEN_HEADER = 'X-Qval-Token'

/** Where the token lives once it is out of the address bar. Per-tab, like the session it names. */
const TOKEN_STORAGE_KEY = 'qval.token'

/** What `GET /api/session` returns: everything the UI needs to boot. */
interface SessionPayload {
  appVersion: string
  settings: Settings
  session: SessionSnapshot | null
}

/**
 * Take the session token off the initial URL, stash it for the rest of the tab's life, and put the
 * address bar back the way it should look. sessionStorage rather than localStorage because the token
 * should die with the tab, and rather than a plain variable because a reload has to survive (the
 * server's lease grace period is built around exactly that).
 */
function captureToken(): string {
  try {
    const url = new URL(window.location.href)
    const fromUrl = url.searchParams.get(TOKEN_PARAM)
    if (!fromUrl) return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl)
    url.searchParams.delete(TOKEN_PARAM)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    return fromUrl
  } catch {
    return ''
  }
}

let cachedToken: string | null = null

/** The session token, captured from the URL on first use. */
export function sessionToken(): string {
  if (cachedToken === null) cachedToken = captureToken()
  return cachedToken
}

/**
 * Hold the review session open. The server treats an `/api/events` stream as the lease on this tab:
 * while it is connected the session is live, and once it has been gone for the grace period the run
 * is recorded as abandoned. Nothing is read off the stream — having it open is the whole contract,
 * and `EventSource` reconnects on its own. The token rides in the query string because `EventSource`
 * cannot set a header.
 *
 * @param baseUrl same-origin by default
 */
export function holdSessionLease(baseUrl = ''): void {
  new EventSource(`${baseUrl}/api/events?${TOKEN_PARAM}=${encodeURIComponent(sessionToken())}`)
}

export interface ApiClientOptions {
  /** Same-origin by default; the server serves the UI and the API from one port. */
  baseUrl?: string
  /** Defaults to the token captured from the page URL, resolved lazily on the first call. */
  token?: string
  fetchImpl?: typeof fetch
}

export function createApiClient(options: ApiClientOptions = {}): IpcApi {
  const base = options.baseUrl ?? ''
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  let token = options.token ?? null
  const currentToken = (): string => (token ??= sessionToken())

  /**
   * One request. A body makes it a POST; the server answers JSON either way, and puts a human
   * sentence in `error` on failure, which is what the toasts show.
   */
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const isPost = body !== undefined
    const res = await doFetch(`${base}${path}`, {
      method: isPost ? 'POST' : 'GET',
      headers: {
        [TOKEN_HEADER]: currentToken(),
        ...(isPost ? { 'Content-Type': 'application/json' } : {})
      },
      body: isPost ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    })
    const payload: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const message = (payload as { error?: string } | null)?.error
      throw new Error(message || `Request failed (${res.status}).`)
    }
    return payload as T
  }

  const loadSession = (): Promise<SessionPayload> => request<SessionPayload>('/api/session')

  return {
    app: {
      getVersion: async () => (await loadSession()).appVersion
    },
    settings: {
      get: async () => (await loadSession()).settings,
      set: async (partial) => {
        // Three fields and no more, mirroring the server's allow-list. The rest of `Settings` is
        // host state the browser has no business writing (spec §19).
        const patch: Partial<Settings> = {}
        if ('schema' in partial) patch.schema = partial.schema
        if ('rules' in partial) patch.rules = partial.rules
        if ('evaluatorName' in partial) patch.evaluatorName = partial.evaluatorName
        // Nothing the server will take: report the settings as they stand rather than 400 on a
        // field only the host writes.
        if (Object.keys(patch).length === 0) return (await loadSession()).settings
        return (await request<{ settings: Settings }>('/api/config', patch)).settings
      }
    },
    session: {
      loadLast: async () => (await loadSession()).session,
      // The server persists on every mutation, so there is nothing to flush — report where the file
      // already is. Save-As needs a path, and paths come from the CLI now.
      save: async () => (await loadSession()).session?.workingPath ?? null,
      mergeComparison: async (id) =>
        (await request<{ session: SessionSnapshot | null }>('/api/comparison', { id, merge: true })).session,
      unmergeComparison: async (id) =>
        (await request<{ session: SessionSnapshot | null }>('/api/comparison', { id, merge: false })).session,
      exportReport: async () => (await request<{ path: string | null }>('/api/export', {})).path
    },
    human: {
      setValues: async (ticketId, values) => {
        await request('/api/result', { ticketId, values })
      }
    },
    review: {
      done: async () => {
        await request('/api/done', {})
      }
    }
  }
}

/** The app's client. Same origin, token taken from the page URL on the first call. */
export const api: IpcApi = createApiClient()
