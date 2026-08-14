// Port of src/main/fsUtil.ts. Same atomic write (temp + rename) so a crash mid-write never
// leaves a half-written eval file, and a concurrent writer can't clobber our temp file.

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

/** Monotonic counter so overlapping writes never share a temp filename. */
let writeSeq = 0

/** Atomically write a value as pretty JSON to `filePath` (create dir → write unique temp → rename). */
export async function atomicWriteJson(filePath, data) {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${writeSeq++}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, filePath)
}

/** Read + JSON-parse a file. Returns null if it's missing or not valid JSON. */
export async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'))
  } catch {
    return null
  }
}
