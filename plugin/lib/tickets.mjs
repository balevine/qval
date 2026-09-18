// Tolerant validation of an imported tickets file in Qbort's shape (spec §2.1). Accept
// `{ meta, tickets }` or a bare tickets array, ignore unknown fields, coerce soft fields, and drop
// any ticket lacking a usable numeric id (or duplicating one). Qval never mutates the dataset, this
// only reads it into a clean list.
//
// One non-object message empties the whole conversation rather than just that message. That is
// deliberate. The dataset fingerprint hashes whatever this returns, so "close enough" is wrong.

/**
 * @typedef {import('@shared/types').Ticket} Ticket
 * @typedef {import('@shared/types').TicketStatus} TicketStatus
 */

/** Mirrors `TICKET_STATUSES` in src/shared/types.ts, which declares the matching union type. */
/** @type {TicketStatus[]} */
export const TICKET_STATUSES = ['new', 'open', 'pending', 'on-hold', 'solved', 'closed']

/** A non-null, non-array object (JSON input only, so no Date/Map cases). */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const asString = (v) => (typeof v === 'string' ? v : '')

/** An author, with both fields falling back to '' rather than failing the message. */
function parseAuthor(raw) {
  if (!isObject(raw)) return { name: '', email: '' }
  return { name: asString(raw.name), email: asString(raw.email) }
}

/** A non-object element fails the array, emptying it, rather than being dropped in place. */
function parseMessages(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (!isObject(item)) return []
    out.push({
      from: parseAuthor(item.from),
      body: asString(item.body),
      isStaff: typeof item.isStaff === 'boolean' ? item.isStaff : false,
      createdAt: asString(item.createdAt)
    })
  }
  return out
}

/**
 * One ticket, or null to drop it (only a missing/non-integer id is fatal).
 * @returns {Ticket | null}
 */
function parseTicket(raw) {
  if (!isObject(raw)) return null
  if (typeof raw.id !== 'number' || !Number.isInteger(raw.id)) return null
  const status = typeof raw.status === 'string' && TICKET_STATUSES.includes(raw.status) ? raw.status : 'open'
  return { id: raw.id, subject: asString(raw.subject), status, messages: parseMessages(raw.messages) }
}

/**
 * Parse raw JSON into tickets + optional source meta, or `null` if it isn't a recognizable tickets
 * file (no usable tickets). Individual malformed tickets are dropped, not fatal.
 * @param {unknown} raw
 * @returns {{ tickets: Ticket[], source: { provider?: string, model?: string } | null } | null}
 */
export function parseTicketsFile(raw) {
  const rawTickets = Array.isArray(raw)
    ? raw
    : isObject(raw) && Array.isArray(raw.tickets)
      ? raw.tickets
      : null
  if (!rawTickets) return null

  const seen = new Set()
  const tickets = []
  for (const item of rawTickets) {
    const parsed = parseTicket(item)
    if (!parsed || seen.has(parsed.id)) continue
    seen.add(parsed.id)
    tickets.push(parsed)
  }
  if (tickets.length === 0) return null

  const meta = isObject(raw) ? raw.meta : null
  const source = readSource(meta)
  return { tickets, source }
}

/** `{provider?, model?}` off the file's `meta`, or null (either field non-string → no source). */
function readSource(meta) {
  if (!isObject(meta)) return null
  const provider = meta.provider
  const model = meta.model
  if (provider !== undefined && typeof provider !== 'string') return null
  if (model !== undefined && typeof model !== 'string') return null
  return provider || model ? { provider, model } : null
}
