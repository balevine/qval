/**
 * Tests for `plugin/bin/qval`, the CLI behind `/qval:review`.
 *
 * Everything here drives the real binary over `child_process` in a temp directory, the way
 * `skillEngine.test.ts` drives the engine. What matters is the contract the skill branches on: the
 * first stdout token, the exit code, and the session record a detached server leaves behind.
 *
 * The server outlives the command that started it, so every case tears its child down by pid.
 */

import { spawnSync } from 'node:child_process'
import { promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readJson } from '@lib/fsUtil.mjs'
import type { Ticket } from '@shared/types'

const CLI = resolve(__dirname, '../plugin/bin/qval')

const TICKETS: Ticket[] = [1, 2].map((id) => ({
  id,
  subject: `Ticket ${id}`,
  status: 'open',
  messages: [{ from: { name: 'A', email: 'a@x.com' }, body: `body ${id}`, isStaff: false, createdAt: 'now' }]
}))

/** The shape `qval status` reads back. */
interface SessionRecord {
  status: 'live' | 'done' | 'abandoned' | 'error'
  pid: number
  url: string | null
  port: number | null
  opened: boolean | null
  workingPath: string
  datasetPath: string | null
  candidates: string[]
  error: string | null
}

let dir: string
/** Every directory a server was started in, so afterEach can find and kill its child. */
let homes: string[] = []

beforeEach(async () => {
  // Realpath, because the CLI reports paths as `process.cwd()` resolves them and macOS's /tmp is a
  // symlink into /private/tmp.
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'qv-cli-')))
  homes = []
})

afterEach(async () => {
  for (const home of homes) {
    const record = await readJson<SessionRecord>(join(home, '.qval-run', 'review-session.json'))
    if (record?.status === 'live') {
      try {
        process.kill(record.pid)
      } catch {
        /* already gone */
      }
    }
  }
  await fs.rm(dir, { recursive: true, force: true })
})

/**
 * A working directory holding a tickets.json, plus whatever else the case needs. A key with a `/`
 * in it is written into the subdirectory, which is how the Qbort layout is built.
 */
async function home(name: string, files: Record<string, unknown> = {}) {
  const path = join(dir, name)
  await fs.mkdir(path, { recursive: true })
  writeFileSync(join(path, 'tickets.json'), JSON.stringify(TICKETS, null, 2))
  for (const [file, value] of Object.entries(files)) {
    await fs.mkdir(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  }
  return path
}

/**
 * What Qbort leaves behind: no `tickets.json` in the working directory at all, and one timestamped
 * file per run under `qbort-output/`. `runs` are distinct datasets, one per subject suffix.
 */
async function qbortHome(name: string, stamps: string[]) {
  const path = await home(name)
  await fs.rm(join(path, 'tickets.json'))
  await fs.mkdir(join(path, 'qbort-output'), { recursive: true })
  for (const stamp of stamps) {
    const tickets = TICKETS.map((t) => ({ ...t, subject: `${t.subject} (${stamp})` }))
    writeFileSync(join(path, 'qbort-output', `tickets-${stamp}.json`), JSON.stringify({ meta: { provider: 'claude-skill' }, tickets }, null, 2))
  }
  return path
}

/** Where a generated eval file or report lands now: `qval-output/` under the working directory. */
const outPath = (cwd: string, name: string) => join(cwd, 'qval-output', name)

function qval(cwd: string, args: string[], env: Record<string, string> = {}) {
  homes.push(cwd)
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  if (res.error) throw res.error
  return { status: res.status, out: res.stdout, err: res.stderr }
}

/** The value of a `KEY value` line in the CLI's output. */
const field = (out: string, key: string) =>
  out
    .split('\n')
    .find((l) => l.startsWith(`${key} `))
    ?.slice(key.length + 1) ?? null

const readRecord = (cwd: string) => readJson<SessionRecord>(join(cwd, '.qval-run', 'review-session.json'))

/** POST as the served page would: token in the header, plus the header the server requires. */
async function post(url: string, path: string, body: unknown = {}) {
  const parsed = new URL(url)
  return fetch(`${parsed.origin}${path}`, {
    method: 'POST',
    headers: {
      'X-Qval-Token': parsed.searchParams.get('t') ?? '',
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'same-origin'
    },
    body: JSON.stringify(body)
  })
}

// --- Resolving what to open --------------------------------------------------

describe('serve: what it opens', () => {
  it('finds the only tickets.json, creates the eval file in qval-output/, and serves detached', async () => {
    const cwd = await home('one')
    const res = qval(cwd, ['serve', '--no-open'])

    expect(res.status).toBe(0)
    expect(res.out.split('\n')[0]).toBe('SERVING')
    expect(field(res.out, 'WORKING_FILE')).toBe(outPath(cwd, 'tickets.qval.json'))
    expect(field(res.out, 'DATASET')).toBe(join(cwd, 'tickets.json'))
    expect(field(res.out, 'CANDIDATES')).toBe('0')
    expect(field(res.out, 'OPENED')).toBe('no')

    // The command returned but the session did not: that is the point of the detached child.
    const record = (await readRecord(cwd))!
    expect(record.status).toBe('live')
    expect(record.pid).not.toBe(process.pid)
    expect(await readJson(outPath(cwd, 'tickets.qval.json'))).not.toBeNull()

    const res2 = await fetch(field(res.out, 'URL')!)
    expect(res2.status).toBe(200)
  })

  it('resumes an existing eval file rather than starting a new one over it', async () => {
    const cwd = await home('resume')
    qval(cwd, ['serve', '--no-open'])
    const first = (await readRecord(cwd))!
    await post(first.url!, '/api/done')

    // Second run, no argument: the *.qval.json now in qval-output/ is the thing to open.
    const res = qval(cwd, ['serve', '--no-open'])
    expect(field(res.out, 'WORKING_FILE')).toBe(outPath(cwd, 'tickets.qval.json'))
    // Resumed from the eval file, whose dataset is the tickets.json sitting next to it.
    expect(field(res.out, 'DATASET')).toBe(join(cwd, 'tickets.json'))
  })

  it('relinks the sibling tickets.json for an eval file it has never served before', async () => {
    // What `/qval:evaluate-tickets` leaves behind: an eval file next to its dataset, and no settings
    // remembering where that dataset is. An eval file references its tickets by fingerprint, so the
    // pair has to be relinked from the directory or there is nothing to review.
    const source = await home('produced')
    qval(source, ['serve', '--no-open'])
    await post((await readRecord(source))!.url!, '/api/done')

    const cwd = await home('elsewhere')
    await fs.mkdir(join(cwd, 'qval-output'), { recursive: true })
    writeFileSync(outPath(cwd, 'tickets.qval.json'), readFileSync(outPath(source, 'tickets.qval.json')))
    const res = qval(cwd, ['serve', '--no-open'])

    expect(res.out.split('\n')[0]).toBe('SERVING')
    expect(field(res.out, 'DATASET')).toBe(join(cwd, 'tickets.json'))
    // The child got far enough to publish a live record, which it only does once the relink worked.
    expect((await readRecord(cwd))!.status).toBe('live')
  })

  it('resumes an eval file left loose in the working directory by an older version', async () => {
    // Every version before qval-output/ existed wrote the eval file here. Starting a second, empty
    // evaluation beside a full one would look like losing every score, so the old location still
    // counts, both for what `serve` opens and for what it offers to merge.
    const source = await home('legacy-source')
    qval(source, ['serve', '--no-open'])
    await post((await readRecord(source))!.url!, '/api/done')

    const cwd = await home('legacy')
    writeFileSync(join(cwd, 'tickets.qval.json'), readFileSync(outPath(source, 'tickets.qval.json')))
    const res = qval(cwd, ['serve', '--no-open'])

    expect(res.out.split('\n')[0]).toBe('SERVING')
    expect(field(res.out, 'WORKING_FILE')).toBe(join(cwd, 'tickets.qval.json'))
    // And it stays where it is: reviewing an old file must not silently relocate it.
    expect(await readJson(outPath(cwd, 'tickets.qval.json'))).toBeNull()
  })

  it('offers the other eval files in the directory as merge candidates', async () => {
    const cwd = await home('candidates', { 'qval-output/alice.qval.json': { not: 'validated yet' } })
    qval(cwd, ['serve', 'tickets.json', '--no-open'])

    const record = (await readRecord(cwd))!
    expect(record.candidates).toEqual(['alice.qval.json'])
  })

  it('refuses an ambiguous directory with the list, instead of guessing', async () => {
    const cwd = await home('ambiguous', { 'qval-output/a.qval.json': {}, 'qval-output/b.qval.json': {} })
    const res = qval(cwd, ['serve', '--no-open'])

    expect(res.status).toBe(2)
    expect(res.err).toMatch(/^AMBIGUOUS 2 eval files/)
    expect(res.err).toContain('a.qval.json')
    expect(res.err).toContain('b.qval.json')
  })

  it('finds a hand-exported dataset by shape rather than by filename', async () => {
    // Nobody who exports from their own helpdesk names the file `tickets.json`, and Qval is not a
    // Qbort accessory. Every .json is opened and judged on what is inside it.
    const cwd = await home('byshape', {
      'zendesk-export-q3.json': TICKETS,
      'settings-backup.json': { some: 'config' } // a .json that is not ticket data
    })
    await fs.rm(join(cwd, 'tickets.json'))

    const res = qval(cwd, ['serve', '--no-open'])
    expect(res.out.split('\n')[0]).toBe('SERVING')
    expect(field(res.out, 'DATASET')).toBe(join(cwd, 'zendesk-export-q3.json'))
    expect(field(res.out, 'WORKING_FILE')).toBe(outPath(cwd, 'zendesk-export-q3.qval.json'))
  })

  it('points at an explicit path when the directory holds no dataset at all', async () => {
    const cwd = join(dir, 'nothing')
    await fs.mkdir(cwd, { recursive: true })
    const res = qval(cwd, ['serve', '--no-open'])

    expect(res.status).toBe(2)
    expect(res.err).toMatch(/^NO_DATASET/)
    // The way out has to be in the message: the dataset may simply live somewhere else.
    expect(res.err).toContain('qval serve <path>')

    // And that is genuinely a way out. A path outside the working directory is accepted.
    const elsewhere = await home('elsewhere-data')
    const res2 = qval(cwd, ['serve', join(elsewhere, 'tickets.json'), '--no-open'])
    expect(res2.out.split('\n')[0]).toBe('SERVING')
    expect(field(res2.out, 'DATASET')).toBe(join(elsewhere, 'tickets.json'))
    // The eval file still lands under the working directory, not next to the far-away dataset.
    expect(field(res2.out, 'WORKING_FILE')).toBe(outPath(cwd, 'tickets.qval.json'))
  })

  it('finds the dataset Qbort left in qbort-output/, and keeps the eval file under the working dir', async () => {
    // Qbort stopped writing a tickets.json beside the working directory: every run lands in
    // `qbort-output/` under a timestamped name. Scanning only the working directory finds nothing.
    const cwd = await qbortHome('qbort-one', ['20260918-221724'])
    const res = qval(cwd, ['serve', '--no-open'])

    expect(res.out.split('\n')[0]).toBe('SERVING')
    expect(field(res.out, 'DATASET')).toBe(join(cwd, 'qbort-output', 'tickets-20260918-221724.json'))
    // Not beside the dataset: the engine writes its eval file into the working directory's
    // qval-output/ too, and that is where the merge-candidate scan looks.
    expect(field(res.out, 'WORKING_FILE')).toBe(outPath(cwd, 'tickets-20260918-221724.qval.json'))
  })

  it('lists several Qbort runs rather than guessing which one to start on', async () => {
    const cwd = await qbortHome('qbort-many', ['20260918-152126', '20260918-221724'])
    const res = qval(cwd, ['serve', '--no-open'])

    expect(res.status).toBe(2)
    expect(res.err).toMatch(/^AMBIGUOUS 2 ticket files/)
    // Relative, so the user can paste a listed line straight back into the command.
    expect(res.err).toContain('  qbort-output/tickets-20260918-152126.json')
    expect(res.err).toContain('  qbort-output/tickets-20260918-221724.json')

    const pick = qval(cwd, ['serve', 'qbort-output/tickets-20260918-152126.json', '--no-open'])
    expect(pick.out.split('\n')[0]).toBe('SERVING')
    expect(field(pick.out, 'DATASET')).toBe(join(cwd, 'qbort-output', 'tickets-20260918-152126.json'))
  })

  it('relinks an eval file by fingerprint when several Qbort runs are candidates', async () => {
    // Resuming a review: the directory is ambiguous by name, but an eval file names its dataset by
    // fingerprint, so there is nothing to ask about. Refusing here would break every second visit.
    const source = await qbortHome('qbort-produced', ['20260918-152126'])
    qval(source, ['serve', '--no-open'])
    await post((await readRecord(source))!.url!, '/api/done')

    const cwd = await qbortHome('qbort-resume', ['20260918-152126', '20260918-221724'])
    await fs.mkdir(join(cwd, 'qval-output'), { recursive: true })
    writeFileSync(
      outPath(cwd, 'tickets-20260918-152126.qval.json'),
      readFileSync(outPath(source, 'tickets-20260918-152126.qval.json'))
    )
    const res = qval(cwd, ['serve', '--no-open'])

    expect(res.out.split('\n')[0]).toBe('SERVING')
    expect(field(res.out, 'DATASET')).toBe(join(cwd, 'qbort-output', 'tickets-20260918-152126.json'))
    expect((await readRecord(cwd))!.datasetPath).toBe(join(cwd, 'qbort-output', 'tickets-20260918-152126.json'))
  })

  it('refuses a directory with nothing to review', async () => {
    const cwd = join(dir, 'empty')
    await fs.mkdir(cwd, { recursive: true })
    expect(qval(cwd, ['serve', '--no-open']).err).toMatch(/^NO_DATASET/)
  })

  it('refuses a file that is neither tickets nor an eval file', async () => {
    const cwd = await home('bad', { 'notes.json': { hello: 'world' } })
    const res = qval(cwd, ['serve', 'notes.json', '--no-open'])
    expect(res.status).toBe(2)
    expect(res.err).toMatch(/^BAD_TICKETS/)
  })

  it('does not start a second server over a live one', async () => {
    const cwd = await home('twice')
    const first = qval(cwd, ['serve', '--no-open'])
    const second = qval(cwd, ['serve', '--no-open'])

    expect(second.status).toBe(0)
    expect(second.out.split('\n')[0]).toBe('ALREADY_SERVING')
    expect(field(second.out, 'URL')).toBe(field(first.out, 'URL'))
  })

  it('hands back the live URL when the file asked for is the one already open', async () => {
    const cwd = await home('twice-named')
    const first = qval(cwd, ['serve', 'tickets.json', '--no-open'])
    const second = qval(cwd, ['serve', 'tickets.json', '--no-open'])

    expect(second.status).toBe(0)
    expect(second.out.split('\n')[0]).toBe('ALREADY_SERVING')
    expect(field(second.out, 'URL')).toBe(field(first.out, 'URL'))
  })

  it('refuses a second file rather than handing back the open session on a different one', async () => {
    const other = TICKETS.map((t) => ({ ...t, subject: `Other ${t.id}` }))
    const cwd = await home('two-datasets', { 'other.json': other })
    qval(cwd, ['serve', 'tickets.json', '--no-open'])

    const second = qval(cwd, ['serve', 'other.json', '--no-open'])
    expect(second.status).toBe(2)
    expect(second.err).toMatch(/^ALREADY_SERVING_OTHER_FILE/)
    // Both files named, so the user can tell which is which, and the URL to go and finish.
    expect(second.err).toContain(outPath(cwd, 'other.qval.json'))
    expect(second.err).toContain(`OPEN ${outPath(cwd, 'tickets.qval.json')}`)
    expect(second.err).toMatch(/URL http:\/\/127\.0\.0\.1:\d+/)
    // And it stayed a refusal: the live session is untouched, not replaced.
    expect((await readRecord(cwd))!.workingPath).toBe(outPath(cwd, 'tickets.qval.json'))
  })

  it('still reports a bad path as a bad path while a session is live', async () => {
    const cwd = await home('live-bad-path', { 'notes.json': { hello: 'world' } })
    qval(cwd, ['serve', 'tickets.json', '--no-open'])

    expect(qval(cwd, ['serve', 'notes.json', '--no-open']).err).toMatch(/^BAD_TICKETS/)
    expect(qval(cwd, ['serve', 'nope.json', '--no-open']).err).toMatch(/^MISSING_FILE/)
  })
})

// --- Opening a browser -------------------------------------------------------

describe('serve: handing over the URL', () => {
  it('treats $BROWSER=true as no browser at all, and still prints the URL', async () => {
    // Claude Code's agent view sets this. Shelling out naively runs `true <url>`, which exits 0
    // without opening anything and leaves the session waiting for a tab that never arrives.
    const cwd = await home('sentinel')
    const res = qval(cwd, ['serve'], { BROWSER: 'true' })

    expect(field(res.out, 'OPENED')).toBe('no')
    expect(field(res.out, 'URL')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}$/)
  })
})

// --- status ------------------------------------------------------------------

describe('status', () => {
  it('says none where nothing has run', async () => {
    const cwd = await home('nostatus')
    const res = qval(cwd, ['status'])
    expect(res.status).toBe(0)
    expect(res.out.trim()).toBe('REVIEW none')
  })

  it('reports a live session, then the outcome once the user finishes', async () => {
    const cwd = await home('lifecycle')
    const serve = qval(cwd, ['serve', '--no-open'])
    const url = field(serve.out, 'URL')!

    const live = qval(cwd, ['status'])
    expect(live.out.split('\n')[0]).toBe('REVIEW live')
    expect(field(live.out, 'URL')).toBe(url)
    expect(live.out).toMatch(/HUMAN scored 0\/2/)

    // A live record holds the URL, and the URL holds the session token, so it must never be
    // readable by anyone else on the machine. Written owner-only, not narrowed after the fact.
    const recordPath = join(cwd, '.qval-run', 'review-session.json')
    expect((await fs.stat(recordPath)).mode & 0o777).toBe(0o600)

    // Score one ticket by hand, then finish, exactly as the browser does.
    await post(url, '/api/config', { schema: [{ key: 'empathy', label: 'Empathy', type: 'score', min: 1, max: 5, step: 1 }] })
    await post(url, '/api/result', { ticketId: 1, values: { empathy: 4 } })
    await post(url, '/api/done')

    // The child has to notice, close, and rewrite the record.
    for (let i = 0; i < 50 && (await readRecord(cwd))?.status === 'live'; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }

    const done = qval(cwd, ['status'])
    expect(done.out.split('\n')[0]).toBe('REVIEW done')
    expect(done.out).toMatch(/HUMAN scored 1\/2/)
    expect(field(done.out, 'FILE')).toBe(outPath(cwd, 'tickets.qval.json'))
    // The URL carried the session token, and the session is over.
    expect((await readRecord(cwd))!.url).toBeNull()
  })

  it('reports a session whose process died as stale rather than live', async () => {
    const cwd = await home('stale')
    qval(cwd, ['serve', '--no-open'])
    const record = (await readRecord(cwd))!
    process.kill(record.pid)
    // Wait for the pid to actually go away before asking.
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(record.pid, 0)
      } catch {
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(qval(cwd, ['status']).out.split('\n')[0]).toBe('REVIEW stale')
  })
})

// --- The config the two halves share -----------------------------------------

describe('shared config with the engine', () => {
  it('seeds the session from EVAL_SCHEMA.json and writes back what was used', async () => {
    const schema = [{ key: 'tone', label: 'Tone', type: 'enum', options: ['warm', 'curt'] }]
    const cwd = await home('config', { 'EVAL_SCHEMA.json': schema, 'EVAL_RULES.md': 'Judge the tone.\n' })

    const serve = qval(cwd, ['serve', '--no-open'])
    const url = field(serve.out, 'URL')!

    // The browser opens onto the engine's config, not the default schema.
    const session = (await (
      await fetch(`${new URL(url).origin}/api/session`, { headers: { 'X-Qval-Token': new URL(url).searchParams.get('t')! } })
    ).json()) as { settings: { schema: { key: string }[]; rules: string } }
    expect(session.settings.schema.map((p) => p.key)).toEqual(['tone'])
    expect(session.settings.rules).toBe('Judge the tone.\n')

    // Change it in the browser, finish, and the engine's files hold what the person actually used.
    await post(url, '/api/config', { rules: 'Judge the tone, generously.\n' })
    await post(url, '/api/done')
    for (let i = 0; i < 50 && (await readRecord(cwd))?.status === 'live'; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }

    expect(await fs.readFile(join(cwd, 'EVAL_RULES.md'), 'utf8')).toBe('Judge the tone, generously.\n')
    expect(await readJson(join(cwd, 'EVAL_SCHEMA.json'))).toMatchObject([{ key: 'tone' }])
    expect(qval(cwd, ['status']).out).toContain('CONFIG_WRITTEN')
  })

  it('leaves the config files alone when the session did not change them', async () => {
    // They are the user's files, often hand-written. A session that only reads must not rewrite
    // them, not even into an equivalent-but-reformatted shape.
    const schema = [{ key: 'tone', label: 'Tone', type: 'enum', options: ['warm', 'curt'] }]
    const cwd = await home('config-untouched', { 'EVAL_SCHEMA.json': schema, 'EVAL_RULES.md': 'Judge the tone.\n' })
    const before = {
      schema: await fs.readFile(join(cwd, 'EVAL_SCHEMA.json'), 'utf8'),
      rules: await fs.readFile(join(cwd, 'EVAL_RULES.md'), 'utf8')
    }

    const url = field(qval(cwd, ['serve', '--no-open']).out, 'URL')!
    // A human score, so the session did real work, just not to the config.
    await post(url, '/api/result', { ticketId: 1, values: { tone: 'warm' } })
    await post(url, '/api/done')
    for (let i = 0; i < 50 && (await readRecord(cwd))?.status === 'live'; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }

    expect(await fs.readFile(join(cwd, 'EVAL_SCHEMA.json'), 'utf8')).toBe(before.schema)
    expect(await fs.readFile(join(cwd, 'EVAL_RULES.md'), 'utf8')).toBe(before.rules)
    expect(qval(cwd, ['status']).out).not.toContain('CONFIG_WRITTEN')
  })
})

// --- Usage -------------------------------------------------------------------

describe('refusals', () => {
  it('exits 1 on an unknown subcommand and on a malformed flag', async () => {
    const cwd = await home('usage')
    expect(qval(cwd, ['frobnicate']).status).toBe(1)
    expect(qval(cwd, ['serve', '--port', 'eighty', '--no-open']).status).toBe(1)
  })
})
