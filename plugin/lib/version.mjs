// The plugin's version has exactly one home: plugin/.claude-plugin/plugin.json. That file is not
// ours to choose (the Claude Code plugin system requires it and installs by the version in it), so
// anything else that needs the number reads it from there rather than keeping a second copy.
//
// This is the same module, for the same reason, as Qbort's lib/version.mjs. The failure it prevents
// is quiet: a stale constant stamps a wrong `appVersion` into every eval file written, and nothing
// fails, so nobody notices until the provenance is needed and is wrong.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readJson } from './fsUtil.mjs'

/** Resolved from this file, so it follows the plugin wherever it is installed. */
const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json')

/**
 * Stamped when the manifest can't be read. `meta.appVersion` is required to be a string, so there
 * has to be a fallback, and a run is not worth failing over a metadata stamp. It reads as
 * obviously-not-a-version on purpose: a real-looking version here would hide a broken install.
 */
export const UNKNOWN_VERSION = 'unknown'

/**
 * The installed plugin's version, from its manifest.
 * @param {string} [manifestPath] override, for tests
 * @returns {Promise<string>} the manifest's `version`, or `UNKNOWN_VERSION`
 */
export async function pluginVersion(manifestPath = MANIFEST_PATH) {
  const manifest = await readJson(manifestPath)
  const version = manifest && typeof manifest === 'object' ? manifest.version : null
  return typeof version === 'string' && version.length > 0 ? version : UNKNOWN_VERSION
}
