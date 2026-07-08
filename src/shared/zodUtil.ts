import { z } from 'zod'

/**
 * Build a zod enum from a readonly string array (a `... as const` tuple or a `readonly T[]`),
 * containing the `[T, ...T[]]` non-empty-tuple cast zod's `z.enum` requires in one place instead of
 * repeating `as unknown as [...]` at every call site.
 */
export function enumFrom<T extends string>(values: readonly T[]): z.ZodEnum<[T, ...T[]]> {
  return z.enum(values as unknown as [T, ...T[]])
}
