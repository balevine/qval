import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withDeadline } from './common'

describe('withDeadline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('aborts and marks timedOut once the timeout elapses', () => {
    const d = withDeadline(undefined, 1000)
    expect(d.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(d.signal.aborted).toBe(true)
    expect(d.timedOut).toBe(true)
    d.clear()
  })

  it('reset() restarts the timer, so a progressing stream never trips it', () => {
    const d = withDeadline(undefined, 1000)
    vi.advanceTimersByTime(900)
    d.reset()
    vi.advanceTimersByTime(900) // 1800 total elapsed, but only 900 since the reset
    expect(d.signal.aborted).toBe(false)
    vi.advanceTimersByTime(100)
    expect(d.signal.aborted).toBe(true)
    expect(d.timedOut).toBe(true)
    d.clear()
  })

  it('forwards a caller cancel without marking it a timeout', () => {
    const caller = new AbortController()
    const d = withDeadline(caller.signal, 1000)
    caller.abort()
    expect(d.signal.aborted).toBe(true)
    expect(d.timedOut).toBe(false)
    d.clear()
  })

  it('clear() cancels the timer — no abort afterwards', () => {
    const d = withDeadline(undefined, 1000)
    d.clear()
    vi.advanceTimersByTime(5000)
    expect(d.signal.aborted).toBe(false)
    expect(d.timedOut).toBe(false)
  })

  it('is already aborted when the caller signal was already aborted', () => {
    const caller = new AbortController()
    caller.abort()
    const d = withDeadline(caller.signal, 1000)
    expect(d.signal.aborted).toBe(true)
    d.clear()
  })
})
