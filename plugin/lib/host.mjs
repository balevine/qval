// The two ambient facts the entry points need from the host it is running on: what time it is, and
// whether a process is still there. They live here because `bin/qval` and the skill engine each
// had their own copy, and the session record one of them writes is the one the other reads.

/** The wall clock, in the ISO-8601 form every timestamp in an eval file and a session record uses. */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * Is that pid still around? This is how a live review session is told apart from one that died
 * without recording an outcome. `EPERM` counts as alive: the process is there, it is just not ours
 * to signal. A non-number is false rather than a throw, since the pid comes out of a JSON record
 * that may predate the field or have been written by hand.
 * @param {unknown} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}
