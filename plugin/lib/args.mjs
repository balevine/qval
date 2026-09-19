// Tiny `--flag value` / `--flag` argument parser. A flag followed by another `--flag` (or by
// nothing) is a boolean true. Every other value is a string.
//
// Bare (non-flag) arguments collect in `_`, following the minimist convention. The engine does not
// read `_`. The subcommand is taken positionally as `argv[0]` before this ever runs, and every
// other input is a named flag. The bucket just keeps a stray positional from being mistaken for
// a flag value.

/**
 * Parse `--flag value` / `--flag` pairs into an object, with bare arguments collected in `_`.
 * @param {string[]} argv
 * @returns {Record<string, string | true> & { _: string[] }}
 */
export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        i++
      }
    } else out._.push(a)
  }
  return out
}

/**
 * The string a `--flag value` carries, or null when the flag is absent, bare (`--flag` with no
 * value), or blank. Both entry points branch on "did the user give me a usable value", and a bare
 * flag parses to `true`, which would stringify to the literal "true" if read naively.
 * @param {Record<string, unknown>} args parsed by `parseArgs`
 * @param {string} name flag name, without the leading dashes
 * @returns {string | null}
 */
export function flagValue(args, name) {
  const v = args[name]
  if (v === undefined || v === true) return null
  const s = String(v).trim()
  return s.length > 0 ? s : null
}
