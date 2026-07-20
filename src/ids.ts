/**
 * Id stamping. Finding, observation, and escalation ids are kernel-assigned
 * at deposit (§15.4) — agents never self-assign them. Injectable so tests
 * are deterministic.
 */
export type IdSource = (prefix: string) => string

/** UUID v4 allocation is separate from short kernel ids: callers that need
 * crash-stable UUIDs must reserve the generated value in durable state. */
export type UuidSource = () => string

/** Platform-backed UUID v4 allocation; no hand-rolled UUID bit shaping. */
export function randomUuids(): UuidSource {
  return () => crypto.randomUUID()
}

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

/** Deterministic UUID v4 values for integration harnesses. The version and
 * variant nibbles remain valid while the final 48 bits carry the sequence. */
export function sequentialUuids(): UuidSource {
  let next = 0
  return () => {
    next += 1
    return `00000000-0000-4000-8000-${next.toString(16).padStart(12, '0')}`
  }
}
