// Port of src/shared/validate.ts (`parseTicketsFile`), with zod replaced by plain guards. Same
// tolerance: accept `{ meta, tickets }` or a bare array, ignore unknown fields, coerce soft fields,
// and drop any ticket lacking a usable numeric id (or duplicating one).
//
// The zod original nests `.catch()` at the *array* level for `messages`, so one non-object message
// empties the whole conversation rather than just that message. The guards below reproduce that
// deliberately. The dataset fingerprint hashes whatever this returns, so "close enough" is wrong.

export const TICKET_STATUSES = ['new', 'open', 'pending', 'on-hold', 'solved', 'closed']

/** Zod's object check: a non-null, non-array object (JSON input only, so no Date/Map cases). */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const asString = (v) => (typeof v === 'string' ? v : '')

/** `z.object({name,email}).catch(...)` with both fields `.catch('')`. */
function parseAuthor(raw) {
  if (!isObject(raw)) return { name: '', email: '' }
  return { name: asString(raw.name), email: asString(raw.email) }
}

/** `z.array(messageSchema).catch([])`: a non-object element fails the array, emptying it. */
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

/** One ticket, or null to drop it (only a missing/non-integer id is fatal). */
function parseTicket(raw) {
  if (!isObject(raw)) return null
  if (typeof raw.id !== 'number' || !Number.isInteger(raw.id)) return null
  const status = typeof raw.status === 'string' && TICKET_STATUSES.includes(raw.status) ? raw.status : 'open'
  return { id: raw.id, subject: asString(raw.subject), status, messages: parseMessages(raw.messages) }
}

/**
 * Parse raw JSON into tickets + optional source meta, or `null` if it isn't a recognizable tickets
 * file (no usable tickets). Individual malformed tickets are dropped, not fatal.
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
