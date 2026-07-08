import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDefaultDir, suggestEvalName, Workspace } from './storage'
import { SettingsStore } from './settings'
import { atomicWriteJson, readJson } from './fsUtil'
import { applyLlmResults, createWorkingFile, normalizeEvalFile } from '@shared/evalFile'
import { configFingerprint } from '@shared/fingerprint'
import { DEFAULT_RULES } from '@shared/rules'
import { DEFAULT_SCHEMA } from '@shared/schema'
import type { EvalSchema } from '@shared/types'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'qv-storage-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('resolveDefaultDir', () => {
  it('prefers the configured dir, else userData', () => {
    expect(resolveDefaultDir('/some/dir', '/user')).toBe('/some/dir')
    expect(resolveDefaultDir(null, '/user')).toBe('/user')
  })
})

describe('suggestEvalName', () => {
  it('derives <stem>.qval.json from the dataset path', () => {
    expect(suggestEvalName('/x/tickets.json')).toBe('tickets.qval.json')
    expect(suggestEvalName('/x/run1.qval.json')).toBe('run1.qval.json')
    expect(suggestEvalName(null)).toBe('evaluation.qval.json')
  })
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
    const ws = new Workspace(settings, dir, '0.1.0', () => 'now')
    // Seed an unlocked (empty) file carrying a deliberately stale config fingerprint.
    await ws.commitWorkingFile(seed('sha256:stale'))
    await ws.ensureConfigStamped()

    const expected = await configFingerprint(DEFAULT_SCHEMA, DEFAULT_RULES)
    expect(ws.currentWorkingFile()!.meta.config.fingerprint).toBe(expected)
  })

  it('leaves a locked file (has scored values) frozen', async () => {
    const settings = new SettingsStore(dir)
    const ws = new Workspace(settings, dir, '0.1.0', () => 'now')
    const locked = applyLlmResults(seed('sha256:frozen'), {
      provider: 'ollama',
      model: 'llama',
      results: [{ ticketId: 1, values: { empathy: 4 }, evaluatedAt: 'now', error: null }]
    })
    await ws.commitWorkingFile(locked)
    await ws.ensureConfigStamped()
    expect(ws.currentWorkingFile()!.meta.config.fingerprint).toBe('sha256:frozen')
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
