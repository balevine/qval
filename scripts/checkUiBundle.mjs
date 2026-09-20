#!/usr/bin/env node
// Fails if the committed `plugin/ui/index.html` is not what the current sources build.
//
// The bundle is a build artifact in the repo, which is usually a bad idea. It is here because the
// plugin folder has to be installable with no build step, so the file has to travel with the source.
// The discipline that makes that safe is this check: rebuild into a temp directory and compare.
//
// Run it after any renderer change. `npm run build && git add plugin/ui/index.html` is the fix.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMMITTED = join(REPO, 'plugin', 'ui', 'index.html')

const out = mkdtempSync(join(tmpdir(), 'qval-ui-'))
try {
  const build = spawnSync(
    process.execPath,
    [join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', out, '--emptyOutDir'],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  )
  if (build.status !== 0) {
    console.error('The UI build failed, so there is nothing to compare against.')
    process.exit(build.status ?? 1)
  }

  let committed
  try {
    committed = readFileSync(COMMITTED, 'utf8')
  } catch {
    console.error(`Missing ${relative(REPO, COMMITTED)}. Run \`npm run build\` and commit it.`)
    process.exit(1)
  }
  const fresh = readFileSync(join(out, 'index.html'), 'utf8')

  if (committed !== fresh) {
    console.error(
      `${relative(REPO, COMMITTED)} is stale: it does not match what the sources build ` +
        `(${committed.length} characters committed, ${fresh.length} fresh).\n` +
        'Run `npm run build` and commit the result.'
    )
    process.exit(1)
  }
  console.log(`UI bundle is current (${fresh.length} characters).`)
} finally {
  rmSync(out, { recursive: true, force: true })
}
