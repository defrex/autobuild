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
