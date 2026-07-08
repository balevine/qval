import { z } from 'zod'
import { TICKET_STATUSES, type Ticket } from './types'
import { enumFrom } from './zodUtil'

/**
 * Tolerant validation of an imported Qbort tickets file (spec §2.1). Accepts `{ meta, tickets }`
 * or a bare tickets array, ignores unknown fields, coerces soft fields, and drops any ticket that
 * lacks a usable numeric id (or duplicates one). Qval never mutates the dataset — this only reads
 * it into a clean `Ticket[]`.
 */

const authorSchema = z
  .object({ name: z.string().catch(''), email: z.string().catch('') })
  .catch({ name: '', email: '' })

const messageSchema = z.object({
  from: authorSchema.default({ name: '', email: '' }),
  body: z.string().catch(''),
  isStaff: z.boolean().catch(false),
  createdAt: z.string().catch('')
})

const statusSchema = z.preprocess(
  (v) => (typeof v === 'string' && (TICKET_STATUSES as readonly string[]).includes(v) ? v : 'open'),
  enumFrom(TICKET_STATUSES)
)

const ticketSchema = z.object({
  id: z.number().int().finite(),
  subject: z.string().catch(''),
  status: statusSchema,
  messages: z.array(messageSchema).catch([])
})

const sourceSchema = z
  .object({ provider: z.string().optional(), model: z.string().optional() })
  .partial()
  .passthrough()

export interface ParsedTickets {
  tickets: Ticket[]
  source: { provider?: string; model?: string } | null
}

/**
 * Parse raw JSON into tickets + optional source meta, or `null` if it isn't a recognizable tickets
 * file (no usable tickets). Individual malformed tickets are dropped, not fatal.
 */
export function parseTicketsFile(raw: unknown): ParsedTickets | null {
  const rawTickets = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { tickets?: unknown }).tickets)
      ? (raw as { tickets: unknown[] }).tickets
      : null
  if (!rawTickets) return null

  const seen = new Set<number>()
  const tickets: Ticket[] = []
  for (const item of rawTickets) {
    const parsed = ticketSchema.safeParse(item)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    tickets.push(parsed.data)
  }
  if (tickets.length === 0) return null

  const metaRaw = raw && typeof raw === 'object' ? (raw as { meta?: unknown }).meta : null
  const sourceParsed = sourceSchema.safeParse(metaRaw)
  const source =
    sourceParsed.success && (sourceParsed.data.provider || sourceParsed.data.model)
      ? { provider: sourceParsed.data.provider, model: sourceParsed.data.model }
      : null

  return { tickets, source }
}
