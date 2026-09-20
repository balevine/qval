// The local HTTP server behind `/qval:review`. Dependency-free node: it serves the single-file UI
// bundle and a handful of JSON endpoints on top of a Workspace the CLI has already bound to files.
//
// **No endpoint accepts a path.** Both file paths (the tickets.json and the *.qval.json) are
// resolved by the CLI from argv and cwd before the browser exists, so there is no path-traversal
// surface to defend. Everything else here is ordinary localhost hygiene: bind 127.0.0.1, require a
// per-session token, allowlist the Host header (that is the DNS-rebinding defense specifically),
// require `Sec-Fetch-Site: same-origin` on mutations, and emit no CORS headers at all.

import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configLocked } from '../lib/evalFile.mjs'
import { validateValues } from '../lib/evalValidate.mjs'
import { reportPathFor } from '../lib/paths.mjs'

/**
 * @typedef {import('@shared/types').Settings} Settings
 * @typedef {import('../lib/workspace.mjs').Workspace} Workspace
 * @typedef {import('../lib/settingsStore.mjs').SettingsStore} SettingsStore
 */

/** How the review session ended. `abandoned` = the browser tab went away and never came back. */
/** @typedef {{ reason: 'done' | 'abandoned', workingPath: string | null }} ReviewOutcome */

const HERE = dirname(fileURLToPath(import.meta.url))

/** The committed single-file UI bundle, built by `npm run build` and checked by `npm run check:ui`. */
export const DEFAULT_UI_FILE = join(HERE, '..', 'ui', 'index.html')

/** Query parameter carrying the session token on the initial page load. */
export const TOKEN_PARAM = 't'
export const TOKEN_HEADER = 'x-qval-token'

/** Reject bodies bigger than this outright — every real request here is a few KB. */
const MAX_BODY_BYTES = 1024 * 1024

/** Grace period after the last SSE client drops before we call the session abandoned. Long enough
 *  to survive a page reload, short enough that closing the tab ends the run promptly. */
const DEFAULT_LEASE_GRACE_MS = 10_000

const SSE_KEEPALIVE_MS = 15_000

/**
 * Content-Security-Policy for the served UI. Every network
 * call the page makes goes to this same origin, so `connect-src 'self'` is the whole story.
 *
 * `script-src` is filled in per response by `contentSecurityPolicy`. The bundle is a single file
 * with its JS inlined, and `'self'` does not cover an inline `<script>`, so the alternative to
 * hashing what we are about to serve would be `'unsafe-inline'` — which is the one directive worth
 * not giving up. The fonts and the icons are inlined as data URIs, hence `data:` on img/font.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'"
]

/**
 * Inline `<script>` blocks, which is all of them: the build emits no `src`. A `</script>` inside the
 * JS is escaped by the bundler, so the lazy match ends at the real closing tag.
 */
const INLINE_SCRIPT_RE = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi

/**
 * The policy for one specific page: `'self'` plus a sha256 of every inline script it carries, which
 * is what lets the single-file bundle run without loosening the directive for everything else.
 * @param {string} html
 * @returns {string}
 */
export function contentSecurityPolicy(html) {
  /** @type {string[]} */
  const hashes = []
  for (const match of html.matchAll(INLINE_SCRIPT_RE)) {
    const body = match[1]
    if (!body) continue
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
  }
  return [["script-src 'self'", ...hashes].join(' '), ...CSP_DIRECTIVES].join('; ')
}

/** Set on every response: never cached, never sniffed, never leaked in a referrer. */
const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
}

/** A fresh 256-bit session token, hex encoded. */
export function generateToken() {
  return randomBytes(32).toString('hex')
}

/**
 * Constant-time token comparison. Length is compared first (and leaks only the length, which is
 * fixed by `generateToken` anyway) because `timingSafeEqual` throws on a mismatch.
 * @param {unknown} presented
 * @param {string} expected
 * @returns {boolean}
 */
export function tokenMatches(presented, expected) {
  if (typeof presented !== 'string') return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Whether a `Host` header may address this server. A browser that has been tricked into resolving
 * an attacker-controlled name to 127.0.0.1 still sends that name here, so pinning the host to the
 * loopback literals is what stops DNS rebinding from reaching the API.
 * @param {unknown} host the raw `Host` header
 * @param {number} port the port we are actually listening on
 * @returns {boolean}
 */
export function hostAllowed(host, port) {
  if (typeof host !== 'string' || !host) return false
  // Split off the port from the right, so `[::1]:8080` survives.
  const i = host.lastIndexOf(':')
  const bracketed = host.endsWith(']')
  const name = i === -1 || bracketed ? host : host.slice(0, i)
  const declared = i === -1 || bracketed ? '' : host.slice(i + 1)
  if (declared !== String(port)) return false
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * Read a JSON request body, bounded. Returns `{ ok: false, status, error }` rather than throwing so
 * the caller can answer with the right code.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, status: number, error: string }>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let tooLarge = false
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      // Past the cap, keep draining but stop accumulating: the sender gets a clean 413 instead of a
      // severed socket. Nothing unauthenticated reaches here — the token is checked before we read.
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => settle({ ok: false, status: 400, error: 'Could not read the request body.' }))
    req.on('end', () => {
      if (tooLarge) return settle({ ok: false, status: 413, error: 'Request body too large.' })
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return settle({ ok: true, value: {} })
      try {
        settle({ ok: true, value: JSON.parse(raw) })
      } catch {
        settle({ ok: false, status: 400, error: 'Request body was not valid JSON.' })
      }
    })
  })
}

/**
 * Build the review server. It owns no paths of its own — `workspace` arrives already bound to the
 * dataset and the working file, and `settings` to a directory.
 *
 * @param {object} options
 * @param {Workspace} options.workspace
 * @param {SettingsStore} options.settings
 * @param {string} options.appVersion
 * @param {string} [options.uiFile] path to the single-file UI bundle
 * @param {string} [options.token] session token (generated when omitted)
 * @param {number} [options.leaseGraceMs] how long the tab may be gone before the session is over
 */
export function createReviewServer({
  workspace,
  settings,
  appVersion,
  uiFile = DEFAULT_UI_FILE,
  token = generateToken(),
  leaseGraceMs = DEFAULT_LEASE_GRACE_MS
}) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set()
  /** True once a browser has connected at least once — before that there is no lease to lose. */
  let leaseHeld = false
  /** @type {NodeJS.Timeout | null} */
  let graceTimer = null
  /** @type {((outcome: ReviewOutcome) => void) | null} */
  let settleFinished = null
  let settled = false
  let closed = false

  /** @type {Promise<ReviewOutcome>} */
  const finished = new Promise((resolve) => {
    settleFinished = resolve
  })

  /** @param {ReviewOutcome['reason']} reason */
  const finish = (reason) => {
    if (settled) return
    settled = true
    settleFinished?.({ reason, workingPath: workspace.currentPath() })
  }

  const clearGrace = () => {
    if (graceTimer) clearTimeout(graceTimer)
    graceTimer = null
  }

  /** The tab is gone. Give it `leaseGraceMs` to come back (a reload drops and re-opens the stream). */
  const startGrace = () => {
    clearGrace()
    // Our own `close()` ends every stream; that is a shutdown, not an abandoned tab.
    if (closed) return
    graceTimer = setTimeout(() => {
      if (clients.size === 0) finish('abandoned')
    }, leaseGraceMs)
    graceTimer.unref?.()
  }

  const keepalive = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n')
  }, SSE_KEEPALIVE_MS)
  keepalive.unref?.()

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {unknown} body
   */
  const sendJson = (res, status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
    res.end(payload)
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {string} message
   */
  const sendError = (res, status, message) => sendJson(res, status, { error: message })

  /** Everything the UI needs to boot: the session, the settings behind it, and our version. */
  const sessionPayload = async () => ({
    appVersion,
    settings: await settings.get(),
    session: workspace.snapshot()
  })

  /** @param {import('node:http').ServerResponse} res */
  const serveUi = async (res) => {
    let html
    try {
      html = await fs.readFile(uiFile, 'utf8')
    } catch {
      res.writeHead(503, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`The Qval UI bundle is missing (${uiFile}). Run \`npm run build\` in the repo.\n`)
      return
    }
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': contentSecurityPolicy(html)
    })
    res.end(html)
  }

  /** @param {import('node:http').ServerResponse} res */
  const openEventStream = (res) => {
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive'
    })
    res.write(`event: hello\ndata: ${JSON.stringify({ appVersion })}\n\n`)
    clients.add(res)
    leaseHeld = true
    clearGrace()
    res.on('close', () => {
      clients.delete(res)
      if (leaseHeld && clients.size === 0) startGrace()
    })
  }

  /**
   * Persist a ticket's human values. The values are re-validated against the **file's** schema (the
   * authoritative one, matching the form the human filled) so a hostile page can't write off-schema
   * data through this endpoint.
   * @param {unknown} body
   * @param {import('node:http').ServerResponse} res
   */
  const postResult = async (body, res) => {
    const file = workspace.currentWorkingFile()
    if (!file) return sendError(res, 409, 'No working file is open.')
    const b = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {}
    if (typeof b.ticketId !== 'number' || !Number.isFinite(b.ticketId)) {
      return sendError(res, 400, 'Invalid ticket id.')
    }
    const s = await settings.get()
    const { values } = validateValues(b.values, file.meta.config.schema)
    await workspace.applyHumanEdit({ ticketId: b.ticketId, values, name: s.evaluatorName || 'Me' })
    sendJson(res, 200, { session: workspace.snapshot() })
  }

  /**
   * Update the working config. Deliberately narrow: the review UI edits the schema, the rules, and
   * the evaluator's display name, and nothing else reaches the settings store.
   *
   * The schema and rules freeze once a file has any scores, and that is checked here as well as in
   * the browser. The browser disables the editors, but a rule the page is merely asked to follow is
   * not a rule: an eval file must never end up claiming a schema its scores were not given under.
   * @param {unknown} body
   * @param {import('node:http').ServerResponse} res
   */
  const postConfig = async (body, res) => {
    const b = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {}
    /** @type {Partial<Settings>} */
    const patch = {}
    if ('schema' in b) patch.schema = /** @type {Settings['schema']} */ (b.schema)
    if ('rules' in b) patch.rules = /** @type {Settings['rules']} */ (b.rules)
    if ('evaluatorName' in b) patch.evaluatorName = String(b.evaluatorName ?? '')
    if (Object.keys(patch).length === 0) return sendError(res, 400, 'Nothing to update.')
    if ('schema' in patch || 'rules' in patch) {
      // Check against the file on disk: an evaluation may have added scores while this session was
      // open, which freezes the schema, and our in-memory copy would not know that yet.
      await workspace.adoptExternalWrite()
      if (configLocked(workspace.currentWorkingFile())) {
        return sendError(res, 409, 'This file already has scores, so its schema and rules are frozen.')
      }
    }

    const next = await settings.set(patch)
    // Keep an unlocked working file's config snapshot in sync as the user edits schema/rules, so
    // its fingerprint stays honest until the first score freezes it.
    if ('schema' in patch || 'rules' in patch) await workspace.ensureConfigStamped()
    sendJson(res, 200, { settings: next, session: workspace.snapshot() })
  }

  /**
   * MERGE or un-merge one of the candidates the CLI resolved, **by id**. The path stays host-side,
   * which is how a browser gets merging back without any endpoint accepting a path. A refusal
   * (different dataset, different config) comes back as a 409 with the reason, because that is a
   * fact about the two files the user needs to read, not a bug.
   * @param {unknown} body
   * @param {import('node:http').ServerResponse} res
   */
  const postComparison = async (body, res) => {
    if (!workspace.currentWorkingFile()) return sendError(res, 409, 'No working file is open.')
    const b = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {}
    if (typeof b.id !== 'string' || !b.id) return sendError(res, 400, 'Invalid comparison id.')
    try {
      if (b.merge === false) workspace.removeComparison(b.id)
      else await workspace.mergeComparison(b.id)
    } catch (err) {
      return sendError(res, 409, err instanceof Error ? err.message : 'Could not merge that file.')
    }
    sendJson(res, 200, { session: workspace.snapshot() })
  }

  /**
   * Write the merged aggregate report. The destination is derived from the working file's own path
   * (`reportPathFor`), so this takes no input at all.
   * @param {import('node:http').ServerResponse} res
   */
  const postExport = async (res) => {
    const path = workspace.currentPath()
    if (!path) return sendError(res, 409, 'No working file is open.')
    const written = await workspace.exportReport(reportPathFor(path))
    sendJson(res, 200, { path: written })
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (res.headersSent) return res.destroy()
      sendError(res, 500, err instanceof Error ? err.message : 'Unexpected server error.')
    })
  })

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'POST') {
      // No OPTIONS handler on purpose: we answer no preflight and emit no CORS headers, so a
      // cross-origin page cannot read anything here even if it reaches us.
      return sendError(res, 405, 'Method not allowed.')
    }

    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : 0
    if (!hostAllowed(req.headers.host, port)) {
      return sendError(res, 403, 'Bad Host header.')
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const presented = req.headers[TOKEN_HEADER] ?? url.searchParams.get(TOKEN_PARAM)
    if (!tokenMatches(presented, token)) {
      return sendError(res, 401, 'Missing or invalid session token.')
    }

    // Mutations must come from the page we served. Browsers always send this header; requiring it
    // (rather than only checking it when present) means a cross-site form post can never qualify.
    if (method === 'POST' && req.headers['sec-fetch-site'] !== 'same-origin') {
      return sendError(res, 403, 'Cross-origin request refused.')
    }

    const path = url.pathname
    if (method === 'GET') {
      if (path === '/' || path === '/index.html') return serveUi(res)
      if (path === '/api/session') return sendJson(res, 200, await sessionPayload())
      if (path === '/api/events') return openEventStream(res)
      return sendError(res, 404, 'Not found.')
    }

    const POST_ROUTES = ['/api/result', '/api/config', '/api/comparison', '/api/export', '/api/done']
    if (!POST_ROUTES.includes(path)) return sendError(res, 404, 'Not found.')

    const body = await readJsonBody(req)
    if (!body.ok) return sendError(res, body.status, body.error)

    if (path === '/api/result') return postResult(body.value, res)
    if (path === '/api/config') return postConfig(body.value, res)
    if (path === '/api/comparison') return postComparison(body.value, res)
    if (path === '/api/export') return postExport(res)
    if (path === '/api/done') {
      // Answer before finishing. `finish` settles the promise the CLI is waiting on to shut the
      // server down, and the tab is still waiting on this response.
      sendJson(res, 200, { ok: true, workingPath: workspace.currentPath() })
      return finish('done')
    }
    // Unreachable through POST_ROUTES above, and that is the point: a route added to that list
    // without a handler here now 404s instead of falling through to FINISH and ending the session.
    return sendError(res, 404, 'Not found.')
  }

  return {
    token,

    /** Whether a browser has ever taken the lease. False forever means nobody opened the URL. */
    get everConnected() {
      return leaseHeld
    },

    /** The port we are listening on, or 0 before `listen`. */
    get port() {
      const address = server.address()
      return address && typeof address === 'object' ? address.port : 0
    },

    /** The URL to hand the browser, token included. */
    get url() {
      return `http://127.0.0.1:${this.port}/?${TOKEN_PARAM}=${token}`
    },

    /** Resolves once the user is done or the tab has been gone for the grace period. */
    finished,

    /**
     * Bind to loopback only. Port 0 asks the OS for a free one.
     * @param {number} [port]
     * @returns {Promise<string>} the URL to open
     */
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve(this.url)
        })
      })
    },

    /** @returns {Promise<void>} */
    close() {
      closed = true
      clearInterval(keepalive)
      clearGrace()
      for (const res of clients) res.end()
      clients.clear()
      return new Promise((resolve) => server.close(() => resolve()))
    }
  }
}
