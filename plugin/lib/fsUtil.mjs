// Atomic write (temp + rename) so a crash mid-write never leaves a half-written eval file, and a
// concurrent writer can't clobber our temp file.

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

/** Monotonic counter so overlapping writes never share a temp filename. */
let writeSeq = 0

/**
 * Atomically write a value as pretty JSON to `filePath` (create dir → write unique temp → rename).
 *
 * `mode` is set on the temp file at creation rather than on the finished one, because `rename`
 * keeps the temp file's inode and so carries its mode across. Narrowing afterwards would leave the
 * content readable at the default umask for the width of the write, which matters for the one file
 * here that holds a secret (the session record's tokenized URL).
 * @param {string} filePath
 * @param {unknown} data
 * @param {object} [options]
 * @param {number} [options.mode] permission bits for the created file. Node's default is 0o666,
 *   which the process umask then narrows.
 * @returns {Promise<void>}
 */
export async function atomicWriteJson(filePath, data, options = {}) {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${writeSeq++}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), {
    encoding: 'utf-8',
    mode: options.mode ?? 0o666
  })
  await fs.rename(tmp, filePath)
}

/**
 * Read + JSON-parse a file. Returns null if it's missing or not valid JSON.
 * @template [T=unknown]
 * @param {string} filePath
 * @returns {Promise<T | null>}
 */
export async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'))
  } catch {
    return null
  }
}
