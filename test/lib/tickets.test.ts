import { describe, expect, it } from 'vitest'
import { parseTicketsFile } from '@lib/tickets.mjs'

const goodTicket = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  subject: `Ticket ${id}`,
  status: 'open',
  messages: [{ from: { name: 'A', email: 'a@x.com' }, body: 'hi', isStaff: false, createdAt: '2026-06-01T00:00:00.000Z' }],
  ...over
})

describe('parseTicketsFile', () => {
  it('parses a { meta, tickets } file and extracts source', () => {
    const parsed = parseTicketsFile({ meta: { provider: 'anthropic', model: 'claude-x' }, tickets: [goodTicket(1)] })
    expect(parsed?.tickets).toHaveLength(1)
    expect(parsed?.source).toEqual({ provider: 'anthropic', model: 'claude-x' })
  })

  it('parses a bare tickets array (no meta → null source)', () => {
    const parsed = parseTicketsFile([goodTicket(1), goodTicket(2)])
    expect(parsed?.tickets).toHaveLength(2)
    expect(parsed?.source).toBeNull()
  })

  it('coerces an unknown status to "open"', () => {
    const parsed = parseTicketsFile([goodTicket(1, { status: 'nonsense' })])
    expect(parsed?.tickets[0].status).toBe('open')
  })

  it('drops tickets without a usable numeric id and de-duplicates ids', () => {
    const parsed = parseTicketsFile([goodTicket(1), goodTicket(1), { id: 'x', subject: 'no id' }, goodTicket(2)])
    expect(parsed?.tickets.map((t) => t.id)).toEqual([1, 2])
  })

  it('returns null for non-tickets JSON and for an empty/invalid set', () => {
    expect(parseTicketsFile({ foo: 'bar' })).toBeNull()
    expect(parseTicketsFile([{ id: 'x' }])).toBeNull()
    expect(parseTicketsFile(null)).toBeNull()
  })

  it('tolerates missing soft fields (defaults body/messages)', () => {
    const parsed = parseTicketsFile([{ id: 5 }])
    expect(parsed?.tickets[0]).toMatchObject({ id: 5, subject: '', status: 'open', messages: [] })
  })
})
