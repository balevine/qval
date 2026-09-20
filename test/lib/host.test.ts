import { describe, expect, it } from 'vitest'
import { nowIso, pidAlive } from '@lib/host.mjs'

describe('nowIso', () => {
  it('is an ISO-8601 instant, which is the form every stored timestamp is compared as', () => {
    const t = nowIso()
    expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(new Date(t).toISOString()).toBe(t)
  })
})

describe('pidAlive', () => {
  it('is true for a process that exists', () => {
    // Our own pid, so nothing has to be spawned and held open to have one.
    expect(pidAlive(process.pid)).toBe(true)
  })

  it('is false for a pid that is not running', () => {
    // Above every configured pid_max on both platforms Qval runs on, so it cannot be in use.
    expect(pidAlive(2 ** 30)).toBe(false)
  })

  it('is false rather than a throw for anything that is not a pid', () => {
    // It is read out of a JSON session record, which may predate the field or have been hand-edited.
    // A crash here would report a live session as an error instead of as absent.
    for (const raw of [undefined, null, 'ok', {}, NaN]) expect(pidAlive(raw)).toBe(false)
  })
})
