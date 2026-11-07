import type { TicketSource, TicketStateCount } from '../types'

/** Shared state rules; configured names are deliberately not create-validated. */
export const STATE_NAME_RULE =
  'a state name is one to forty characters of lowercase letters, digits, and hyphens, starting with a letter'

export function validateStateName(name: string, source = 'file ticket source'): void {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) {
    throw new Error(`${source}: invalid state name "${name}" — ${STATE_NAME_RULE}`)
  }
}

export function validateStatePurpose(
  value: string | undefined,
  source = 'file ticket source',
): string | undefined {
  const about = value?.trim()
  if (about !== undefined && (about === '' || /[\r\n]/.test(about))) {
    throw new Error(`${source}: a state purpose must be one nonblank line`)
  }
  return about
}

export function orderStates(names: string[], lifecycle: readonly string[]): string[] {
  const first = [...new Set(lifecycle)].filter((name) => names.includes(name))
  return [...first, ...names.filter((name) => !first.includes(name)).sort()]
}

export function resolveState(
  name: string,
  existing: string[],
  source = 'file ticket source',
): string {
  if (existing.includes(name)) return name
  const matches = existing.filter((s) => s.toLowerCase() === name.toLowerCase())
  if (matches.length === 1) return matches[0] as string
  const directories = source === 'file ticket source'
  if (matches.length > 1) {
    throw new Error(
      `${source}: ambiguous state "${name}" — it matches the ${directories ? 'directories' : 'states'} ${matches.join(', ')}`,
    )
  }
  throw new Error(
    `${source}: unknown state "${name}" — this tracker's states are ${directories ? 'the directories: ' : ''}${existing.join(', ')}`,
  )
}

/** Ticket count of the named state using `resolveState`'s matching (exact,
 * else one case-insensitive match); zero or ambiguous matches are unknown. */
export function triageStateCount(
  states: readonly TicketStateCount[],
  name: string,
): number | undefined {
  const exact = states.find((state) => state.name === name)
  if (exact !== undefined) return exact.tickets
  const matches = states.filter((state) => state.name.toLowerCase() === name.toLowerCase())
  return matches.length === 1 ? matches[0]?.tickets : undefined
}

/** One bounded display count for the named state: a single
 * `countStates([name])` request, never a listing. Undefined when the source
 * has no bounded counts or the name does not resolve uniquely; rejects when
 * the read fails, so callers can keep their last good value. */
export async function boundedStateCount(
  source: Pick<TicketSource, 'countStates'>,
  name: string,
): Promise<number | undefined> {
  if (source.countStates === undefined) return undefined
  return triageStateCount(await source.countStates([name]), name)
}

/** Canonical names for requested states using `resolveState`'s matching
 * (exact, else one case-insensitive match); unmatched or ambiguous names are
 * dropped, duplicates collapse, and request order is kept. */
export function matchStateNames(names: readonly string[], existing: readonly string[]): string[] {
  const matched: string[] = []
  for (const name of names) {
    let canonical: string | undefined
    if (existing.includes(name)) canonical = name
    else {
      const matches = existing.filter((state) => state.toLowerCase() === name.toLowerCase())
      if (matches.length === 1) canonical = matches[0]
    }
    if (canonical !== undefined && !matched.includes(canonical)) matched.push(canonical)
  }
  return matched
}

/** Portable directory vocabulary, without guessing lifecycle roles. */
export function normalizeStateName(name: string): string {
  if (/^[a-z][a-z0-9-]{0,39}$/.test(name)) return name
  const candidate = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  try {
    validateStateName(candidate)
  } catch {
    throw new Error(`invalid state "${name}" (normalized: "${candidate}")`)
  }
  return candidate
}
