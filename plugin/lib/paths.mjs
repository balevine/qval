// The directories and filenames Qval derives rather than asks for. They live here, apart from
// `workspace.mjs`, because the engine needs them too and has no business importing a `Workspace`
// (and everything under it) to name a file. One copy: a second one that drifts puts the engine's
// eval file and the CLI's in different places, and the merge-candidate scan only looks in one.
//
// **None of these can be configured.** Both commands write to the same fixed directory names under
// the user's working directory, which is how each one finds files the other left. There used to be
// an `--out` flag to move them: if a review was started with one value and an evaluation run with
// another, neither could see the other's files, and nothing ever used the flag anyway.
//
// Node-only (`node:fs`, `node:path`), so nothing the renderer imports may import this.

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

/** Durable artifacts: the `*.qval.json` eval files and the `*.report.json` exports. Named after
 *  Qbort's `qbort-output/`, and for the same reason — generated files belong somewhere, not loose
 *  in the directory the user keeps their own files in. Gitignored like any other generated output,
 *  but **not** safe to delete: a human evaluation lives here and has no other copy. */
export const OUTPUT_DIR = 'qval-output'

/** Scratch: compiled prompts, raw subagent output, run state, the review session record, settings,
 *  Hidden, gitignored, and safe to delete between runs, which `OUTPUT_DIR` is not. */
export const RUN_DIR = '.qval-run'

/** `tickets.qval.json` → `tickets`, and `tickets.json` → `tickets`. */
const stemOf = (path) => basename(path, extname(path)).replace(/\.qval$/, '')

/**
 * Suggest a `<dataset>.qval.json` filename from the backing tickets path.
 * @param {string | null} datasetPath
 * @returns {string}
 */
export function suggestEvalName(datasetPath) {
  if (!datasetPath) return 'evaluation.qval.json'
  return `${stemOf(datasetPath)}.qval.json`
}

/**
 * Where `exportReport` writes, derived from the working file rather than chosen: `tickets.qval.json`
 * → `tickets.report.json`, alongside it. The browser names no destination.
 * @param {string} workingPath
 * @returns {string}
 */
export function reportPathFor(workingPath) {
  return join(dirname(workingPath), `${stemOf(workingPath)}.report.json`)
}

/**
 * Where a dataset's eval file goes when nobody named one: `<dir>/qval-output/<stem>.qval.json`.
 *
 * Versions before this one put the eval file straight in the working directory instead. If one is
 * still sitting there, it is used rather than starting a new one in `qval-output/`. Without that,
 * upgrading would create a second, empty eval file next to the full one, and the person would only
 * find out when a merge was refused or a review opened with all its scores apparently gone.
 *
 * @param {string} dir the working directory
 * @param {string | null} datasetPath
 * @param {(path: string) => boolean} [exists] injectable for tests
 * @returns {string}
 */
export function defaultEvalPath(dir, datasetPath, exists = existsSync) {
  const name = suggestEvalName(datasetPath)
  const legacy = join(dir, name)
  return exists(legacy) ? legacy : join(dir, OUTPUT_DIR, name)
}

/**
 * The two places an eval file can be, in the order to look: `qval-output/`, then the working
 * directory itself, where older versions put it. Both are searched so that a file written before
 * `qval-output/` existed can still be opened and still be offered for merging.
 * @param {string} dir the working directory
 * @returns {string[]}
 */
export const evalSearchDirs = (dir) => [join(dir, OUTPUT_DIR), dir]

/**
 * Turn a path into one canonical form, so that two ways of writing the same file compare as equal.
 *
 * Symlinks are the reason. On macOS `/var` is a symlink to `/private/var`, so one process can write
 * `/var/…/tickets.qval.json` into the session record while another reads the same file as
 * `/private/var/…/tickets.qval.json`. Comparing the two as plain strings says they are different
 * files, and a check that two processes are holding the same one would never fire.
 *
 * The file does not have to exist yet, and often does not (`qval-output/` is created by the run
 * that calls this). So this resolves the closest parent directory that does exist and puts the
 * remaining names back on the end.
 *
 * @param {string} p
 * @returns {string}
 */
export function canonicalPath(p) {
  const abs = resolve(p)
  const tail = []
  let head = abs
  for (;;) {
    try {
      return join(realpathSync(head), ...tail)
    } catch {
      const parent = dirname(head)
      if (parent === head) return abs // walked to the root without finding anything real
      tail.unshift(basename(head))
      head = parent
    }
  }
}

/** Do two paths name the same file, allowing for symlinks and for either one not existing yet? */
export const samePath = (a, b) => Boolean(a) && Boolean(b) && canonicalPath(a) === canonicalPath(b)
