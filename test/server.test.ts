/**
 * Tests for the review server (`plugin/server/server.mjs`).
 *
 * It lives in `test/` rather than beside the module because it crosses the repo/plugin boundary,
 * the same reason `skillEngine.test.ts` does. Every test drives a real listening server over real
 * HTTP on an OS-assigned loopback port, because the things worth checking here (the `Host`
 * allowlist, the token, `Sec-Fetch-Site`) are all properties of actual requests.
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createReviewServer, hostAllowed, tokenMatches, TOKEN_HEADER } from '../plugin/server/server.mjs'
import { Workspace } from '@lib/workspace.mjs'
import { SettingsStore } from '@lib/settingsStore.mjs'
import { atomicWriteJson, readJson } from '@lib/fsUtil.mjs'
import { DEFAULT_SCHEMA } from '@lib/schema.mjs'
import type { EvalFile, SessionSnapshot, Settings, Ticket } from '@shared/types'

// --- Fixtures ----------------------------------------------------------------

const TICKETS: Ticket[] = [1, 2].map((id) => ({
  id,
  subject: `Ticket ${id}`,
  status: 'open',
  messages: [{ from: { name: 'A', email: 'a@x.com' }, body: `body ${id}`, isStaff: false, createdAt: 'now' }]
}))

/**
 * A raw request, because `fetch` rewrites `Host` to match the URL it was given and so can't be used
 * to forge one. The rebinding defense is precisely about a forged `Host`, so it needs the low-level
 * client.
 */
function rawRequest(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

let dir: string
/** Every server started by a test, torn down in afterEach so no port outlives its case. */
let running: { close: () => Promise<void> }[] = []

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'qv-server-'))
  running = []
})
afterEach(async () => {
  await Promise.all(running.map((s) => s.close()))
  await fs.rm(dir, { recursive: true, force: true })
})

/**
 * A listening server over a fresh workspace already bound to a tickets.json and an eval-file path,
 * which is the state the CLI hands it (spec: the server never sees a path of its own).
 */
async function start(options: { leaseGraceMs?: number; uiFile?: string } = {}) {
  const home = join(dir, `run-${running.length}`)
  const ticketsPath = join(home, 'tickets.json')
  await atomicWriteJson(ticketsPath, TICKETS)

  const settings = new SettingsStore(home)
  const workspace = new Workspace(settings, '0.1.0', () => 'now')
  await workspace.open(ticketsPath)
  const evalPath = join(home, 'tickets.qval.json')
  await workspace.save(evalPath)

  const server = createReviewServer({ workspace, settings, appVersion: '0.1.0', ...options })
  const url = await server.listen()
  running.push(server)

  const origin = `http://127.0.0.1:${server.port}`
  /** A same-origin request the way the served page would make it. */
  const call = (path: string, init: RequestInit = {}) =>
    fetch(origin + path, {
      ...init,
      headers: {
        [TOKEN_HEADER]: server.token,
        'Content-Type': 'application/json',
        ...(init.method === 'POST' ? { 'Sec-Fetch-Site': 'same-origin' } : {}),
        ...init.headers
      }
    })

  return { server, workspace, settings, origin, url, evalPath, home, call }
}

// --- Pure helpers ------------------------------------------------------------

describe('hostAllowed', () => {
  it('accepts only the loopback literals on the port we are actually bound to', () => {
    expect(hostAllowed('127.0.0.1:8080', 8080)).toBe(true)
    expect(hostAllowed('localhost:8080', 8080)).toBe(true)
    expect(hostAllowed('[::1]:8080', 8080)).toBe(true)

    expect(hostAllowed('evil.example.com:8080', 8080)).toBe(false)
    expect(hostAllowed('127.0.0.1:9999', 8080)).toBe(false) // wrong port
    expect(hostAllowed('127.0.0.1', 8080)).toBe(false) // no port at all
    expect(hostAllowed('', 8080)).toBe(false)
    expect(hostAllowed(undefined, 8080)).toBe(false)
  })
})

describe('tokenMatches', () => {
  it('is exact, and safe against non-strings and length mismatches', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abd', 'abc')).toBe(false)
    expect(tokenMatches('ab', 'abc')).toBe(false)
    expect(tokenMatches('abcd', 'abc')).toBe(false)
    expect(tokenMatches(undefined, 'abc')).toBe(false)
    expect(tokenMatches(['abc'], 'abc')).toBe(false)
  })
})

// --- The security stack ------------------------------------------------------

describe('access control', () => {
  it('refuses a missing or wrong token on every route', async () => {
    const { origin, server } = await start()
    for (const path of ['/', '/api/session', '/api/events']) {
      expect((await fetch(origin + path)).status).toBe(401)
      expect((await fetch(origin + path, { headers: { [TOKEN_HEADER]: 'nope' } })).status).toBe(401)
      // A token of the right length but the wrong bytes must fail like any other.
      const wrong = 'f'.repeat(server.token.length)
      expect((await fetch(origin + path, { headers: { [TOKEN_HEADER]: wrong } })).status).toBe(401)
    }
  })

  it('accepts the token from the query string, which is how the page is first opened', async () => {
    const { url } = await start()
    expect((await fetch(url)).status).not.toBe(401)
  })

  it('refuses a foreign Host header before it ever looks at the token', async () => {
    const { server } = await start()
    const good = { [TOKEN_HEADER]: server.token, Host: `127.0.0.1:${server.port}` }

    // A rebound name resolves to us and carries a valid token, and still gets nowhere.
    const rebound = await rawRequest(server.port, '/api/session', {
      ...good,
      Host: `evil.example.com:${server.port}`
    })
    expect(rebound.status).toBe(403)
    expect(JSON.parse(rebound.body).error).toMatch(/Host/)

    // Same request, honest Host: through.
    expect((await rawRequest(server.port, '/api/session', good)).status).toBe(200)
  })

  it('refuses a mutation that is not same-origin', async () => {
    const { origin, server } = await start()
    const post = (site?: string) =>
      fetch(origin + '/api/result', {
        method: 'POST',
        headers: {
          [TOKEN_HEADER]: server.token,
          'Content-Type': 'application/json',
          ...(site ? { 'Sec-Fetch-Site': site } : {})
        },
        body: JSON.stringify({ ticketId: 1, values: {} })
      })

    expect((await post('cross-site')).status).toBe(403)
    expect((await post('same-site')).status).toBe(403)
    expect((await post(undefined)).status).toBe(403) // absent counts as refused, not as trusted
    expect((await post('same-origin')).status).toBe(200)
  })

  it('emits no CORS headers and answers no preflight', async () => {
    const { origin, call } = await start()
    const res = await call('/api/session')
    for (const h of ['access-control-allow-origin', 'access-control-allow-credentials']) {
      expect(res.headers.get(h)).toBeNull()
    }
    expect((await fetch(origin + '/api/session', { method: 'OPTIONS' })).status).toBe(405)
  })

  it('rejects a body over the size cap', async () => {
    const { call } = await start()
    const res = await call('/api/config', {
      method: 'POST',
      body: JSON.stringify({ rules: 'x'.repeat(2 * 1024 * 1024) })
    })
    expect(res.status).toBe(413)
  })
})

// --- The endpoints -----------------------------------------------------------

describe('GET /api/session', () => {
  it('returns the version, the settings, and the bound session', async () => {
    const { call } = await start()
    const res = await call('/api/session')
    expect(res.status).toBe(200)

    const body = (await res.json()) as { appVersion: string; settings: Settings; session: SessionSnapshot }
    expect(body.appVersion).toBe('0.1.0')
    expect(body.session.tickets.map((t) => t.id)).toEqual([1, 2])
    expect(body.settings.schema).toEqual(DEFAULT_SCHEMA)
  })
})

describe('POST /api/result', () => {
  it('persists human values to the bound file, re-validated against its schema', async () => {
    const { call, evalPath } = await start()
    await call('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        schema: [{ key: 'empathy', label: 'Empathy', type: 'score', min: 1, max: 5, step: 1 }],
        evaluatorName: 'Ada'
      })
    })

    const res = await call('/api/result', {
      method: 'POST',
      // 99 is out of range and must come back clamped; `bogus` isn't in the schema at all and must
      // be dropped rather than taking the good value down with it.
      body: JSON.stringify({ ticketId: 1, values: { empathy: 99, bogus: 'x' } })
    })
    expect(res.status).toBe(200)

    const onDisk = (await readJson(evalPath)) as EvalFile
    const human = onDisk.evaluators.find((e) => e.kind === 'human')!
    expect(human.name).toBe('Ada')
    expect(human.results[0].ticketId).toBe(1)
    // Clamped to the range, and the off-schema key is gone. Human results carry no `issues[]`.
    // that repair trail belongs to the LLM, and this matches what the app's IPC path persists.
    expect(human.results[0].values).toEqual({ empathy: 5 })
  })

  it('adopts an evaluation written underneath it instead of overwriting it', async () => {
    // The whole point of the guard: the working file is held in memory for the length of a session,
    // and `/qval:evaluate-tickets` writes the same path. Without the re-read the next human edit
    // persists a copy taken before the run and silently erases every LLM result in it.
    const { call, evalPath } = await start()

    const before = (await readJson(evalPath)) as EvalFile
    await atomicWriteJson(evalPath, {
      ...before,
      meta: { ...before.meta, updatedAt: '2030-01-01T00:00:00.000Z' },
      evaluators: [
        {
          id: 'llm',
          kind: 'llm',
          name: 'LLM · Opus 5',
          provider: 'claude-code',
          model: 'Opus 5',
          results: [{ ticketId: 1, values: { resolved: true }, evaluatedAt: 'then', error: null }]
        }
      ]
    })

    const res = await call('/api/result', {
      method: 'POST',
      body: JSON.stringify({ ticketId: 2, values: { resolved: false } })
    })
    expect(res.status).toBe(200)

    const after = (await readJson(evalPath)) as EvalFile
    expect(after.evaluators.find((e) => e.kind === 'llm')?.results).toHaveLength(1)
    expect(after.evaluators.find((e) => e.kind === 'human')?.results[0].ticketId).toBe(2)
  })

  it('refuses to write over a file that became a different evaluation', async () => {
    const { call, evalPath } = await start()
    const before = (await readJson(evalPath)) as EvalFile
    const replaced = {
      ...before,
      meta: {
        ...before.meta,
        updatedAt: '2030-01-01T00:00:00.000Z',
        dataset: { ...before.meta.dataset, fingerprint: 'sha256:somethingelse' }
      }
    }
    await atomicWriteJson(evalPath, replaced)

    const res = await call('/api/result', {
      method: 'POST',
      body: JSON.stringify({ ticketId: 1, values: { resolved: true } })
    })
    expect(res.status).toBe(500)
    expect(await readJson(evalPath)).toEqual(replaced) // refusing means writing nothing
  })

  it('rejects a ticket id that is not a number', async () => {
    const { call } = await start()
    const res = await call('/api/result', { method: 'POST', body: JSON.stringify({ ticketId: '1' }) })
    expect(res.status).toBe(400)
  })

  it('rejects a body that is not JSON', async () => {
    const { call } = await start()
    const res = await call('/api/result', { method: 'POST', body: 'not json' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/config', () => {
  it('updates schema/rules and re-stamps the unlocked file so its fingerprint stays honest', async () => {
    const { call, workspace } = await start()
    const before = workspace.currentWorkingFile()!.meta.config.fingerprint

    const res = await call('/api/config', {
      method: 'POST',
      body: JSON.stringify({ rules: 'Score generously.', evaluatorName: 'Ada' })
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { settings: Settings; session: SessionSnapshot }
    expect(body.settings.rules).toBe('Score generously.')
    expect(body.settings.evaluatorName).toBe('Ada')
    expect(body.session.workingFile.meta.config.rules).toBe('Score generously.')
    expect(body.session.workingFile.meta.config.fingerprint).not.toBe(before)
  })

  it('ignores fields the review UI has no business setting', async () => {
    const { call } = await start()
    const res = await call('/api/config', {
      method: 'POST',
      body: JSON.stringify({ rules: 'x', lastDatasetPath: '/etc/passwd', defaultDir: '/etc' })
    })
    const body = (await res.json()) as { settings: Settings }
    expect(body.settings.lastDatasetPath).not.toBe('/etc/passwd')
    expect(body.settings).not.toHaveProperty('defaultDir')
  })

  it('refuses an update with nothing in it', async () => {
    const { call } = await start()
    expect((await call('/api/config', { method: 'POST', body: '{}' })).status).toBe(400)
  })
})

describe('POST /api/comparison', () => {
  /** A second eval file over the same tickets and the same config, which is what merges. */
  async function sibling(home: string, workspace: Workspace, name = 'alice.qval.json') {
    const file = workspace.currentWorkingFile()!
    const path = join(home, name)
    await atomicWriteJson(path, {
      ...file,
      evaluators: [
        { kind: 'human', name: 'Alice', results: [{ ticketId: 1, values: {}, updatedAt: 'now' }] }
      ]
    })
    return path
  }

  it('merges a candidate by id, and the path never leaves the host', async () => {
    const { call, workspace, home } = await start()
    workspace.setComparisonSources([{ id: 'c1', name: 'alice.qval.json', path: await sibling(home, workspace) }])

    const res = await call('/api/comparison', { method: 'POST', body: JSON.stringify({ id: 'c1', merge: true }) })
    expect(res.status).toBe(200)

    const { session } = (await res.json()) as { session: SessionSnapshot }
    expect(session.comparisons.map((c) => c.name)).toEqual(['alice.qval.json'])
    expect(session.candidates).toEqual([{ id: 'c1', name: 'alice.qval.json', merged: true }])
    // What the browser gets told about the file is its name. Not where it is.
    expect(JSON.stringify(session.candidates)).not.toContain(home)
  })

  it('un-merges by the same id', async () => {
    const { call, workspace, home } = await start()
    workspace.setComparisonSources([{ id: 'c1', name: 'alice.qval.json', path: await sibling(home, workspace) }])
    await call('/api/comparison', { method: 'POST', body: JSON.stringify({ id: 'c1', merge: true }) })

    const res = await call('/api/comparison', { method: 'POST', body: JSON.stringify({ id: 'c1', merge: false }) })
    const { session } = (await res.json()) as { session: SessionSnapshot }
    expect(session.comparisons).toEqual([])
    expect(session.candidates[0].merged).toBe(false)
  })

  it('answers a fingerprint mismatch with the reason, not a 500', async () => {
    const { call, workspace, home } = await start()
    const path = await sibling(home, workspace)
    const raw = (await readJson(path)) as EvalFile
    await atomicWriteJson(path, {
      ...raw,
      meta: { ...raw.meta, config: { ...raw.meta.config, fingerprint: 'sha256:different' } }
    })
    workspace.setComparisonSources([{ id: 'c1', name: 'alice.qval.json', path }])

    const res = await call('/api/comparison', { method: 'POST', body: JSON.stringify({ id: 'c1', merge: true }) })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/different scoring criteria/i)
  })

  it('refuses an id it was never offered', async () => {
    const { call } = await start()
    const res = await call('/api/comparison', { method: 'POST', body: JSON.stringify({ id: '../../etc/passwd' }) })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/no longer available/i)
  })
})

describe('POST /api/export', () => {
  it('writes the report beside the working file, taking no destination from the client', async () => {
    const { call, home } = await start()
    const res = await call('/api/export', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)

    const { path } = (await res.json()) as { path: string }
    expect(path).toBe(join(home, 'tickets.report.json'))
    expect((await readJson(path)) as { meta: { app: string } }).toMatchObject({ meta: { app: 'qval-report' } })
  })
})

// --- The client lease --------------------------------------------------------

describe('the SSE client lease', () => {
  it('resolves `finished` as done when the user finishes, and reports the bound path', async () => {
    const { call, server, evalPath } = await start()
    expect((await call('/api/done', { method: 'POST', body: '{}' })).status).toBe(200)
    await expect(server.finished).resolves.toEqual({ reason: 'done', workingPath: evalPath })
  })

  it('resolves `finished` as abandoned once the tab has been gone for the grace period', async () => {
    const { origin, server } = await start({ leaseGraceMs: 20 })
    const stream = await fetch(`${origin}/api/events`, { headers: { [TOKEN_HEADER]: server.token } })
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/)

    // A reader that goes away is exactly what closing the tab looks like from here.
    await stream.body!.cancel()
    await expect(server.finished).resolves.toMatchObject({ reason: 'abandoned' })
  })

  it('does not abandon the session before a browser has ever connected', async () => {
    const { server } = await start({ leaseGraceMs: 5 })
    const raced = await Promise.race([
      server.finished,
      new Promise((r) => setTimeout(() => r('still waiting'), 60))
    ])
    expect(raced).toBe('still waiting')
  })
})

// --- Static serving ----------------------------------------------------------

describe('serving the UI', () => {
  it('serves the bundle under the locked-down CSP', async () => {
    const uiFile = join(dir, 'index.html')
    await fs.writeFile(uiFile, '<h1>Qval</h1>')
    const { call } = await start({ uiFile })

    const res = await call('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>Qval</h1>')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(res.headers.get('content-security-policy')).toContain("frame-src 'none'")
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it("names the bundle's inline script by hash rather than allowing inline scripts", async () => {
    const script = 'console.log("qval")'
    const uiFile = join(dir, 'index.html')
    await fs.writeFile(uiFile, `<!doctype html><script type="module">${script}</script><div id="root"></div>`)
    const { call } = await start({ uiFile })

    const csp = (await call('/')).headers.get('content-security-policy') ?? ''
    const hash = createHash('sha256').update(script, 'utf8').digest('base64')
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src'))
    // The single-file bundle inlines its JS, and `'self'` does not cover an inline script. Hashing
    // what we are about to serve is what keeps `'unsafe-inline'` out of this directive.
    expect(scriptSrc).toBe(`script-src 'self' 'sha256-${hash}'`)
  })

  it('hashes nothing when there is nothing inline to hash', async () => {
    const uiFile = join(dir, 'index.html')
    await fs.writeFile(uiFile, '<!doctype html><script src="./app.js"></script>')
    const { call } = await start({ uiFile })

    const csp = (await call('/')).headers.get('content-security-policy') ?? ''
    expect(csp.split('; ').find((d) => d.startsWith('script-src'))).toBe("script-src 'self'")
  })

  it('says so plainly when the bundle has not been built', async () => {
    const { call } = await start({ uiFile: join(dir, 'absent.html') })
    const res = await call('/')
    expect(res.status).toBe(503)
    expect(await res.text()).toMatch(/UI bundle is missing/)
  })

  it('404s an unknown route rather than falling back to the app shell', async () => {
    const { call } = await start()
    expect((await call('/api/nope')).status).toBe(404)
    expect((await call('/whatever')).status).toBe(404)
  })
})
