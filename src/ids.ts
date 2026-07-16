/**
 * Id stamping. Finding, observation, and escalation ids are kernel-assigned
 * at deposit (§15.4) — agents never self-assign them. Injectable so tests
 * are deterministic.
 */
export type IdSource = (prefix: string) => string

/** e.g. `f_3a91c07b` — 4 random bytes, hex. */
export function randomIds(): IdSource {
  return (prefix) => {
    const bytes = new Uint8Array(4)
    crypto.getRandomValues(bytes)
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${prefix}_${hex}`
  }
}

/** Deterministic ids for tests: `f_1`, `f_2`, … (counter per prefix). */
export function sequentialIds(): IdSource {
  const counters = new Map<string, number>()
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1
    counters.set(prefix, next)
    return `${prefix}_${next}`
  }
}
