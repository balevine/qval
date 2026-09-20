/**
 * Tests for `plugin/lib/version.mjs`, the single source of the plugin's version.
 *
 * The last case is the one that matters in practice: it is the guard that keeps the repo's
 * `package.json` from drifting away from the plugin manifest. Nothing reads `package.json` at
 * runtime, so drift there is silent, and a released plugin whose repo claims a different version is
 * exactly the confusion having one source of truth is meant to prevent.
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { pluginVersion, UNKNOWN_VERSION } from '@lib/version.mjs'

const REPO_ROOT = resolve(__dirname, '../..')
const MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'qv-version-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Write a manifest into the temp dir and return its path. */
async function manifest(contents: unknown) {
  const path = join(dir, 'plugin.json')
  await fs.writeFile(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
  return path
}

describe('pluginVersion', () => {
  it('reads the real manifest by default', async () => {
    const declared = JSON.parse(await fs.readFile(MANIFEST, 'utf8')) as { version: string }
    expect(await pluginVersion()).toBe(declared.version)
    // A plausible version, not the fallback: this is what gets stamped into every eval file.
    expect(await pluginVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('falls back rather than throwing when the manifest is unusable', async () => {
    // A metadata stamp is not worth failing a run over, but it must not silently look valid.
    expect(await pluginVersion(join(dir, 'does-not-exist.json'))).toBe(UNKNOWN_VERSION)
    expect(await pluginVersion(await manifest('{ not json'))).toBe(UNKNOWN_VERSION)
    expect(await pluginVersion(await manifest({ name: 'qval' }))).toBe(UNKNOWN_VERSION)
    expect(await pluginVersion(await manifest({ version: '' }))).toBe(UNKNOWN_VERSION)
    expect(await pluginVersion(await manifest({ version: 2 }))).toBe(UNKNOWN_VERSION)
    expect(await pluginVersion(await manifest([1, 2, 3]))).toBe(UNKNOWN_VERSION)
  })

  it('keeps package.json and the plugin manifest on the same version', async () => {
    const pkg = JSON.parse(await fs.readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
    expect(pkg.version).toBe(await pluginVersion())
  })
})
