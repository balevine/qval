import { describe, expect, it } from 'vitest'
import {
  canonicalizeConfig,
  canonicalizeTickets,
  configFingerprint,
  datasetFingerprint,
  sha256Hex
} from './fingerprint'
import type { EvalSchema, Ticket } from './types'

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 1,
  subject: 'Cannot log in',
  status: 'open',
  messages: [
    { from: { name: 'Sarah', email: 's@example.com' }, body: 'help', isStaff: false, createdAt: '2026-06-28T09:14:00.000Z' }
  ],
  ...over
})

const schema: EvalSchema = [
  { key: 'empathy', label: 'Empathy', type: 'score', min: 1, max: 5, step: 1 },
  { key: 'resolved', label: 'Resolved', type: 'boolean' }
]

describe('sha256Hex', () => {
  it('matches the known SHA-256 vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})

describe('dataset fingerprint', () => {
  it('ignores extra/unknown fields and object formatting', async () => {
    const a = ticket()
    // Same content, but with extra fields the canonicalizer should ignore.
    const b = { ...ticket(), extra: 'ignored', messages: [{ ...ticket().messages[0], junk: 1 }] } as unknown as Ticket
    expect(canonicalizeTickets([a])).toBe(canonicalizeTickets([b]))
    expect(await datasetFingerprint([a])).toBe(await datasetFingerprint([b]))
  })

  it('changes when ticket content changes', async () => {
    const base = await datasetFingerprint([ticket()])
    const edited = await datasetFingerprint([ticket({ subject: 'Different' })])
    expect(edited).not.toBe(base)
  })

  it('is prefixed with sha256:', async () => {
    expect(await datasetFingerprint([ticket()])).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('config fingerprint', () => {
  it('ignores rules whitespace-only differences', async () => {
    expect(canonicalizeConfig(schema, 'be fair')).toBe(canonicalizeConfig(schema, '  be fair  '))
    expect(await configFingerprint(schema, 'be fair')).toBe(await configFingerprint(schema, '  be fair  '))
  })

  it('changes when the schema changes', async () => {
    const a = await configFingerprint(schema, 'rules')
    const b = await configFingerprint([...schema, { key: 'x', label: 'X', type: 'boolean' }], 'rules')
    expect(b).not.toBe(a)
  })

  it('changes when the rules text changes', async () => {
    const a = await configFingerprint(schema, 'rules one')
    const b = await configFingerprint(schema, 'rules two')
    expect(b).not.toBe(a)
  })

  it('is independent of the dataset fingerprint', async () => {
    expect(await configFingerprint(schema, 'r')).not.toBe(await datasetFingerprint([ticket()]))
  })
})
