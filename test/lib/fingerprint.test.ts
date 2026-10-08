import { describe, expect, it } from 'vitest'
import {
  canonicalizeConfig,
  canonicalizeTickets,
  configFingerprint,
  datasetFingerprint,
  sha256Hex
} from '@lib/fingerprint.mjs'
import { DEFAULT_SCHEMA } from '@lib/schema.mjs'
import { DEFAULT_RULES } from '@lib/rules.mjs'
import type { EvalProperty, EvalSchema, Ticket } from '@shared/types'

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

describe('config fingerprint stability', () => {
  // Literal hashes taken before scorers existed. Every eval file already on disk carries one of
  // these, so a change here means existing files silently stop merging with new ones.
  const legacy: EvalSchema = [
    { key: 'empathy', label: 'Empathy', type: 'score', min: 1, max: 5, step: 0.5, description: 'How warm was the reply?' },
    { key: 'channel', label: 'Channel', type: 'enum', options: ['email', 'chat', 'phone'] },
    { key: 'notes', label: 'Notes', type: 'text', description: 'Anything else.' },
    { key: 'ratings', label: 'Ratings', type: 'score', multiple: true, min: 0, max: 10, step: 1 }
  ]

  it('hashes the default config exactly as it did before scorers existed', () => {
    const expected = 'sha256:dbb2ebd9c601813ed2d9adeb9834c86e68c85545fc29b0a1c71ee798fb9d31e8'
    expect(configFingerprint(DEFAULT_SCHEMA, DEFAULT_RULES)).toBe(expected)
    expect(configFingerprint(DEFAULT_SCHEMA, DEFAULT_RULES, 'claude')).toBe(expected)
  })

  it('hashes a score/enum/text schema exactly as it did before scorers existed', () => {
    const expected = 'sha256:7c2061ff338ae3de68d150d79796e3a0568dbfe81301f1eeefa9e3c2104762b5'
    expect(configFingerprint(legacy, 'Score the staff reply.', 'claude')).toBe(expected)
  })

  it('ignores jev fields on a claude config', () => {
    const decorated = legacy.map((p) => ({ ...p, instructions: 'Ask this.' }))
    expect(configFingerprint(decorated, 'Score the staff reply.', 'claude')).toBe(
      configFingerprint(legacy, 'Score the staff reply.', 'claude')
    )
  })
})

describe('jev config fingerprint', () => {
  const jev = (over: Partial<EvalProperty>[] = []): EvalSchema => {
    const base: EvalProperty[] = [
      {
        key: 'tone', label: 'Tone', type: 'score', min: 0, max: 2, step: 1, instructions: 'How warm was the reply?',
        levels: [{ label: 'Cold', description: 'Curt.' }, { label: 'Neutral' }, { label: 'Warm', description: 'Kind.' }]
      },
      { key: 'solved', label: 'Solved', type: 'boolean', instructions: 'Was it solved?', trueDescription: 'Fixed.' },
      {
        key: 'kind', label: 'Kind', type: 'enum', options: ['bug', 'billing'], instructions: 'Which kind?',
        optionDescriptions: { bug: 'Broken.', billing: 'Money.' }
      }
    ]
    return base.map((p, i) => ({ ...p, ...(over[i] ?? {}) }))
  }

  it('never matches a claude config of the same schema and rules', () => {
    expect(configFingerprint(jev(), 'r', 'jev')).not.toBe(configFingerprint(jev(), 'r', 'claude'))
  })

  it('differs when only the instructions differ', () => {
    expect(configFingerprint(jev([{ instructions: 'How kind was the reply?' }]), 'r', 'jev')).not.toBe(
      configFingerprint(jev(), 'r', 'jev')
    )
  })

  it('differs when only one level description differs', () => {
    const changed = jev()[0].levels!.map((l, i) => (i === 1 ? { ...l, description: 'Flat.' } : l))
    expect(configFingerprint(jev([{ levels: changed }]), 'r', 'jev')).not.toBe(configFingerprint(jev(), 'r', 'jev'))
  })

  it('differs when a boolean or option description differs', () => {
    const base = configFingerprint(jev(), 'r', 'jev')
    expect(configFingerprint(jev([{}, { falseDescription: 'Open.' }]), 'r', 'jev')).not.toBe(base)
    expect(configFingerprint(jev([{}, {}, { optionDescriptions: { bug: 'Broken.', billing: 'Refunds.' } }]), 'r', 'jev')).not.toBe(base)
  })

  it('is stable across option-description key order and whitespace', () => {
    const reordered = jev([{}, {}, { optionDescriptions: { billing: ' Money. ', bug: 'Broken.' } }])
    expect(configFingerprint(reordered, 'r', 'jev')).toBe(configFingerprint(jev(), 'r', 'jev'))
  })

  describe("a multi-select's own option questions", () => {
    const multi = (over: Partial<EvalProperty> = {}) =>
      jev([{}, {}, { multiple: true, instructions: 'Which kinds?', ...over }])
    const own = {
      optionInstructions: { bug: 'Is it a bug?', billing: 'Is it billing?' },
      optionTrueDescriptions: { bug: 'A bug.', billing: 'Billing.' },
      optionFalseDescriptions: { bug: 'No bug.', billing: 'No billing.' }
    }

    it('leave the hash of a config without them exactly as it was', () => {
      expect(canonicalizeConfig(multi(), 'r', 'jev')).not.toContain('optionQuestions')
    })

    it('change the hash when any one of them changes', () => {
      const base = configFingerprint(multi(own), 'r', 'jev')
      expect(base).not.toBe(configFingerprint(multi(), 'r', 'jev'))
      const falseChanged = { ...own.optionFalseDescriptions, billing: 'Not about money.' }
      expect(configFingerprint(multi({ ...own, optionFalseDescriptions: falseChanged }), 'r', 'jev')).not.toBe(base)
      const reordered = { billing: ' Is it billing? ', bug: 'Is it a bug?' }
      expect(configFingerprint(multi({ ...own, optionInstructions: reordered }), 'r', 'jev')).toBe(base)
    })
  })
})
