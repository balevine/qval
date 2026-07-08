import type { EvalProperty, EvalSchema, Ticket } from './types'
import { normalizeSchema } from './schema'

/**
 * Canonical hashing for the two merge-matching identities (spec §2.5). Both fingerprints hash a
 * canonicalized *content* string (not raw file bytes), so re-exports/reformatting still match
 * while any real content change doesn't. Pure + environment-agnostic (Web Crypto is available in
 * both the Electron main process and the renderer), so main and renderer compute identical values.
 */

/**
 * Reduce the tickets to their meaningful fields in a fixed key order, dropping Qbort's `meta` and
 * all formatting. Building the objects in explicit order makes `JSON.stringify` deterministic
 * without a generic key sorter.
 */
export function canonicalizeTickets(tickets: Ticket[]): string {
  const canon = tickets.map((t) => ({
    id: t.id,
    subject: t.subject,
    status: t.status,
    messages: (t.messages ?? []).map((m) => ({
      name: m.from?.name ?? '',
      email: m.from?.email ?? '',
      body: m.body,
      isStaff: m.isStaff,
      createdAt: m.createdAt
    }))
  }))
  return JSON.stringify(canon)
}

/** Canonical form of one property (fixed key order; type-specific fields only where relevant). */
function canonProperty(p: EvalProperty): unknown {
  return {
    key: p.key,
    label: p.label,
    type: p.type,
    multiple: p.multiple === true,
    description: p.description?.trim() ?? '',
    min: p.type === 'score' ? p.min : null,
    max: p.type === 'score' ? p.max : null,
    step: p.type === 'score' ? p.step : null,
    options: p.type === 'enum' ? p.options ?? [] : null
  }
}

/**
 * Canonical form of the eval config: the *normalized* schema (so equivalent schemas match) in
 * declared order, plus the trimmed rules text (whitespace-only differences normalized out).
 */
export function canonicalizeConfig(schema: EvalSchema, rules: string): string {
  return JSON.stringify({
    schema: normalizeSchema(schema).map(canonProperty),
    rules: rules.trim()
  })
}

/** SHA-256 of a UTF-8 string as lowercase hex, via Web Crypto (works in main and renderer). */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** `sha256:<hex>` over the canonicalized tickets — the dataset identity for merge. */
export async function datasetFingerprint(tickets: Ticket[]): Promise<string> {
  return `sha256:${await sha256Hex(canonicalizeTickets(tickets))}`
}

/** `sha256:<hex>` over the canonicalized {schema, rules} — the config identity for merge. */
export async function configFingerprint(schema: EvalSchema, rules: string): Promise<string> {
  return `sha256:${await sha256Hex(canonicalizeConfig(schema, rules))}`
}
