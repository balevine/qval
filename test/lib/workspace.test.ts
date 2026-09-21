import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '@lib/workspace.mjs'
import { SettingsStore } from '@lib/settingsStore.mjs'
import { atomicWriteJson, readJson } from '@lib/fsUtil.mjs'
import { applyLlmResults, createWorkingFile, normalizeEvalFile } from '@lib/evalFile.mjs'
import { configFingerprint } from '@lib/fingerprint.mjs'
import { DEFAULT_RULES } from '@lib/rules.mjs'
import { DEFAULT_SCHEMA } from '@lib/schema.mjs'
import type { EvalSchema } from '@shared/types'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'qv-storage-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('ensureConfigStamped', () => {
  const seed = (fp: string, schema: EvalSchema = DEFAULT_SCHEMA) =>
    createWorkingFile({
      appVersion: '0.1.0',
      now: '2026-07-02T00:00:00.000Z',
      dataset: { fingerprint: 'sha256:aaa', ticketCount: 1, source: null },
      config: { fingerprint: fp, schema, rules: DEFAULT_RULES }
    })

  it('re-stamps an unlocked working file to match the current schema/rules', async () => {
    const settings = new SettingsStore(dir)
    const ws = new Workspace(settings, '0.1.0', () => 'now')
    // Seed an unlocked (empty) file carrying a deliberately stale config fingerprint.
    await ws.commitWorkingFile(seed('sha256:stale'))
    await ws.ensureConfigStamped()

    const expected = await configFingerprint(DEFAULT_SCHEMA, DEFAULT_RULES)
    expect(ws.currentWorkingFile()!.meta.config.fingerprint).toBe(expected)
  })

  it('leaves a locked file (has scored values) frozen', async () => {
    const settings = new SettingsStore(dir)
    const ws = new Workspace(settings, '0.1.0', () => 'now')
    const locked = applyLlmResults(seed('sha256:frozen'), {
      provider: 'claude-code',
      model: 'Opus 5',
      results: [{ ticketId: 1, values: { empathy: 4 }, evaluatedAt: 'now', error: null }]
    })
    await ws.commitWorkingFile(locked)
    await ws.ensureConfigStamped()
    expect(ws.currentWorkingFile()!.meta.config.fingerprint).toBe('sha256:frozen')
  })
})

describe('explicit-path file operations', () => {
  const ticket = (id: number) => ({
    id,
    subject: `Ticket ${id}`,
    status: 'open',
    messages: [{ from: { name: 'A', email: 'a@x.biz' }, body: `body ${id}`, isStaff: false, createdAt: 'now' }]
  })

  /** A workspace over its own settings dir, plus a tickets.json written to `dir`. */
  const seedWorkspace = async (name: string, tickets = [ticket(1), ticket(2)]) => {
    const home = join(dir, name)
    const ticketsPath = join(home, 'tickets.json')
    await atomicWriteJson(ticketsPath, tickets)
    const ws = new Workspace(new SettingsStore(home), '0.1.0', () => 'now')
    return { home, ticketsPath, ws }
  }

  it('imports a tickets.json into a fresh, unsaved working file', async () => {
    const { ticketsPath, ws } = await seedWorkspace('import')
    const snap = await ws.open(ticketsPath)
    expect(snap.tickets.map((t) => t.id)).toEqual([1, 2])
    expect(snap.workingFile.evaluators).toEqual([])
    expect(ws.currentPath()).toBeNull() // an imported dataset has no eval file to write back to
  })

  it('rejects a file that is neither tickets nor an eval file', async () => {
    const { home, ws } = await seedWorkspace('junk')
    const path = join(home, 'junk.json')
    await atomicWriteJson(path, { nothing: 'useful' })
    await expect(ws.open(path)).rejects.toThrow(/neither a tickets.json nor/)
  })

  it('saves to an explicit path, then keeps saving to it', async () => {
    const { home, ticketsPath, ws } = await seedWorkspace('save')
    await ws.open(ticketsPath)
    const out = join(home, 'run.qval.json')

    expect(await ws.save()).toBeNull() // nowhere to write yet. The caller owns Save-As
    expect(await ws.save(out)).toBe(out)
    expect(ws.currentPath()).toBe(out)
    expect(await ws.save()).toBe(out) // now bound

    expect(normalizeEvalFile(await readJson(out))).toEqual(ws.currentWorkingFile())
  })

  it('reopens a saved eval file, relinking the dataset from lastDatasetPath', async () => {
    const { home, ticketsPath, ws } = await seedWorkspace('reopen')
    await ws.open(ticketsPath)
    const out = join(home, 'run.qval.json')
    await ws.save(out)

    // A cold workspace over the same settings dir: nothing in memory, but lastDatasetPath is set.
    const cold = new Workspace(new SettingsStore(home), '0.1.0', () => 'now')
    const snap = await cold.open(out)
    expect(snap.tickets.map((t) => t.id)).toEqual([1, 2])
    expect(cold.currentPath()).toBe(out)
  })

  it('falls back to the locator, and fails cleanly when it declines', async () => {
    const { home, ticketsPath, ws } = await seedWorkspace('locate')
    await ws.open(ticketsPath)
    const out = join(home, 'run.qval.json')
    await ws.save(out)

    // Workspaces with no memory of the dataset at all. Only the locator can supply it.
    let n = 0
    const fresh = () => new Workspace(new SettingsStore(join(dir, `cold-${n++}`)), '0.1.0', () => 'now')

    await expect(fresh().open(out)).rejects.toThrow(/Could not find the tickets.json/)
    await expect(fresh().open(out, async () => null)).rejects.toThrow(/Could not find the tickets.json/)

    const found = await fresh().open(out, async () => ticketsPath)
    expect(found.tickets.map((t) => t.id)).toEqual([1, 2])
  })

  it('picks the matching dataset out of a list of candidates', async () => {
    // A host that cannot narrow a directory down to one file hands over all of them: the
    // fingerprint is the disambiguator, so this cannot mislink. Qbort keeps every run, which is
    // what makes several ticket files in one place the normal case.
    const { home, ticketsPath, ws } = await seedWorkspace('candidates')
    await ws.open(ticketsPath)
    const out = join(home, 'run.qval.json')
    await ws.save(out)

    const decoy = join(home, 'decoy-tickets.json')
    await atomicWriteJson(decoy, [ticket(9)])

    const cold = new Workspace(new SettingsStore(join(dir, 'candidates-cold')), '0.1.0', () => 'now')
    const found = await cold.open(out, async () => [decoy, ticketsPath])
    expect(found.tickets.map((t) => t.id)).toEqual([1, 2])
    // The one that matched is remembered, so the next open skips the scan entirely.
    expect((await cold.settings.get()).lastDatasetPath).toBe(ticketsPath)
  })

  it('rejects a located tickets file from a different dataset', async () => {
    const { home, ticketsPath, ws } = await seedWorkspace('mismatch')
    await ws.open(ticketsPath)
    const out = join(home, 'run.qval.json')
    await ws.save(out)

    const other = join(home, 'other-tickets.json')
    await atomicWriteJson(other, [ticket(9)])
    const cold = new Workspace(new SettingsStore(join(dir, 'mismatch-cold')), '0.1.0', () => 'now')
    await expect(cold.open(out, async () => other)).rejects.toThrow(/different dataset/)
    // Same when a whole list is offered and none of it is this dataset: "offered and wrong" is a
    // different answer from "nothing offered", which is the one that reports as not-found.
    const cold2 = new Workspace(new SettingsStore(join(dir, 'mismatch-cold-2')), '0.1.0', () => 'now')
    await expect(cold2.open(out, async () => [other])).rejects.toThrow(/different dataset/)
  })

  it('gates addComparison on both fingerprints and refuses duplicates', async () => {
    const { home, ticketsPath, ws } = await seedWorkspace('merge')
    await ws.open(ticketsPath)
    const peer = join(home, 'peer.qval.json')
    await ws.save(peer)

    // Same tickets, same config: a legitimate merge (it is literally the file we just wrote).
    const snap = await ws.addComparison(peer)
    expect(snap!.comparisons.map((c) => c.id)).toEqual([peer])
    await expect(ws.addComparison(peer)).rejects.toThrow(/already merged/)

    const file = normalizeEvalFile(await readJson(peer))!
    const otherDataset = join(home, 'other-dataset.qval.json')
    await atomicWriteJson(otherDataset, {
      ...file,
      meta: { ...file.meta, dataset: { ...file.meta.dataset, fingerprint: 'sha256:zzz' } }
    })
    await expect(ws.addComparison(otherDataset)).rejects.toThrow(/Different dataset/)

    const otherConfig = join(home, 'other-config.qval.json')
    await atomicWriteJson(otherConfig, {
      ...file,
      meta: { ...file.meta, config: { ...file.meta.config, fingerprint: 'sha256:zzz' } }
    })
    await expect(ws.addComparison(otherConfig)).rejects.toThrow(/Different rules or schema/)
  })

  it('exports a merged report to the given path', async () => {
    const { home, ticketsPath, ws } = await seedWorkspace('report')
    await ws.open(ticketsPath)
    const out = join(home, 'report.json')
    expect(await ws.exportReport(out)).toBe(out)

    const report = await readJson<{ meta: { app: string }; rollup: unknown; tickets: { subject: string }[] }>(out)
    expect(report!.meta.app).toBe('qval-report')
    expect(report!.tickets.map((t) => t.subject)).toEqual(['Ticket 1', 'Ticket 2'])
  })
})

describe('working file persistence', () => {
  it('writes atomically and reloads identically through normalizeEvalFile', async () => {
    const file = createWorkingFile({
      appVersion: '0.1.0',
      now: '2026-07-02T00:00:00.000Z',
      dataset: { fingerprint: 'sha256:aaa', ticketCount: 2, source: null },
      config: { fingerprint: 'sha256:bbb', schema: DEFAULT_SCHEMA, rules: DEFAULT_RULES }
    })
    const path = join(dir, 'run.qval.json')
    await atomicWriteJson(path, file)
    const reloaded = normalizeEvalFile(await readJson(path))
    expect(reloaded).toEqual(file)
  })
})
