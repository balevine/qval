import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  canonicalPath,
  defaultEvalPath,
  evalSearchDirs,
  reportPathFor,
  samePath,
  suggestEvalName
} from '@lib/paths.mjs'

describe('suggestEvalName', () => {
  it('derives <stem>.qval.json from the dataset path', () => {
    expect(suggestEvalName('/x/tickets.json')).toBe('tickets.qval.json')
    expect(suggestEvalName('/x/zendesk-export-q3.json')).toBe('zendesk-export-q3.qval.json')
    // Already an eval file: the `.qval` isn't doubled up.
    expect(suggestEvalName('/x/run1.qval.json')).toBe('run1.qval.json')
    expect(suggestEvalName(null)).toBe('evaluation.qval.json')
  })
})

describe('reportPathFor', () => {
  it('writes the report beside the working file, never inside it', () => {
    expect(reportPathFor('/x/tickets.qval.json')).toBe('/x/tickets.report.json')
    expect(reportPathFor('/x/y/run1.qval.json')).toBe('/x/y/run1.report.json')
  })
})

describe('defaultEvalPath', () => {
  const none = () => false

  it('puts a new eval file in qval-output/', () => {
    expect(defaultEvalPath('/w', '/w/tickets.json', none)).toBe('/w/qval-output/tickets.qval.json')
    // Named after the dataset, wherever the dataset happens to live.
    expect(defaultEvalPath('/w', '/elsewhere/zendesk-q3.json', none)).toBe('/w/qval-output/zendesk-q3.qval.json')
  })

  it('keeps using one an older version left loose in the working directory', () => {
    // Otherwise upgrading starts a second, empty evaluation beside a full one, and the first sign
    // of it is a review that looks like it lost every score.
    const legacy = (p: string) => p === '/w/tickets.qval.json'
    expect(defaultEvalPath('/w', '/w/tickets.json', legacy)).toBe('/w/tickets.qval.json')
  })
})

describe('evalSearchDirs', () => {
  it('looks in qval-output/ first, then the working directory itself', () => {
    expect(evalSearchDirs('/w')).toEqual(['/w/qval-output', '/w'])
  })
})

describe('canonicalPath', () => {
  let dir: string
  let real: string

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'qv-path-'))
    real = await fs.realpath(dir)
    await fs.mkdir(join(real, 'qval-output'), { recursive: true })
    await fs.writeFile(join(real, 'qval-output', 'tickets.qval.json'), '{}')
    await fs.symlink(join(real, 'qval-output'), join(real, 'link'))
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('resolves a symlinked directory, so two spellings of one file compare as equal', () => {
    // This is the case that matters. macOS puts /tmp behind a symlink, so one process records a
    // path the other reads back differently and a plain string compare says they are different
    // evaluations.
    expect(canonicalPath(join(real, 'link', 'tickets.qval.json'))).toBe(
      join(real, 'qval-output', 'tickets.qval.json')
    )
  })

  it('canonicalizes a file that does not exist yet from the nearest parent that does', () => {
    // `qval-output/` is often created by the very run doing the comparing, so refusing to answer
    // for a missing file would leave the check useless exactly when it is needed.
    expect(canonicalPath(join(real, 'link', 'not-created-yet.qval.json'))).toBe(
      join(real, 'qval-output', 'not-created-yet.qval.json')
    )
    expect(canonicalPath(join(real, 'nope', 'deep', 'a.qval.json'))).toBe(
      join(real, 'nope', 'deep', 'a.qval.json')
    )
  })

  it('makes a relative path absolute', () => {
    expect(canonicalPath('x.qval.json')).toBe(join(process.cwd(), 'x.qval.json'))
  })
})

describe('samePath', () => {
  it('is false when either side is missing, rather than calling two nothings equal', () => {
    expect(samePath(null, '/w/a.qval.json')).toBe(false)
    expect(samePath('/w/a.qval.json', undefined)).toBe(false)
    expect(samePath(null, null)).toBe(false)
  })

  it('compares two names for the same file as equal', () => {
    expect(samePath('/w/a.qval.json', '/w/./x/../a.qval.json')).toBe(true)
    expect(samePath('/w/a.qval.json', '/w/b.qval.json')).toBe(false)
  })
})
