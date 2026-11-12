/**
 * Label-selected role profiles (SPEC §9).
 *
 * A `[profiles.<name>]` table names one ticket label and any number of role
 * entries. A build whose ticket carries that label at claim records the
 * profile on `build.created`; every later session of that build resolves its
 * role through the profile's overlay of the CURRENT configuration.
 *
 * The overlay is a synthetic roles map: a profile entry's declared fields sit
 * over `[roles.<role>]` (or over nothing when the repository does not declare
 * the role), and the resolver then merges each field over `[roles.default]`
 * exactly as it does for repository roles. An omitted field therefore falls
 * back to `[roles.<role>]`, then `[roles.default]`; a declared `alternates`
 * list, including `[]`, replaces the inherited list.
 *
 * Everything here is pure and in memory. Selection reads only the labels the
 * ready scan already returned.
 */
import { defineEntry } from '../open-map'
import { displayName } from './roles'
import type { RoleConfig } from './schema'

export interface ProfileConfig {
  label: string
  roles: Record<string, RoleConfig>
}

/** Labels match case-insensitively after trimming, as forge and Linear labels do. */
export function normalizeProfileLabel(label: string): string {
  return label.trim().toLowerCase()
}

/**
 * The repository roles with one profile's entries overlaid. Keys stay intact
 * end to end (`__proto__` included), and only fields an entry actually
 * declares replace the repository role's value.
 */
export function profileRoles<T extends object>(
  roles: Record<string, T>,
  entries: Record<string, T>,
): Record<string, T> {
  const overlaid: Record<string, T> = Object.create(null)
  for (const key of Object.keys(roles)) defineEntry(overlaid, key, roles[key]!)
  for (const key of Object.keys(entries)) {
    const base = (Object.hasOwn(roles, key) ? roles[key]! : {}) as T
    const merged = Object.create(null) as T
    for (const [field, value] of Object.entries(base))
      if (value !== undefined) defineEntry(merged as Record<string, unknown>, field, value)
    for (const [field, value] of Object.entries(entries[key]!))
      if (value !== undefined) defineEntry(merged as Record<string, unknown>, field, value)
    defineEntry(overlaid, key, merged)
  }
  return overlaid
}

export type ProfileSelection =
  | { kind: 'none' }
  | { kind: 'selected'; name: string }
  | { kind: 'conflict'; matches: { name: string; label: string }[] }

/** Which configured profile a ticket's labels select. Two or more distinct
 * profiles matching is a conflict: profiles never combine. */
export function selectProfile(
  profiles: Record<string, { label: string }> | undefined,
  labels: readonly string[] | undefined,
): ProfileSelection {
  if (profiles === undefined || labels === undefined || labels.length === 0) return { kind: 'none' }
  const carried = new Set(labels.map(normalizeProfileLabel))
  const matches: { name: string; label: string }[] = []
  for (const name of Object.keys(profiles)) {
    const label = profiles[name]!.label
    if (normalizeProfileLabel(label).length === 0) continue
    if (carried.has(normalizeProfileLabel(label))) matches.push({ name, label })
  }
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length === 1) return { kind: 'selected', name: matches[0]!.name }
  matches.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return { kind: 'conflict', matches }
}

function andList(parts: readonly string[]): string {
  if (parts.length <= 2) return parts.join(' and ')
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

/** The scan diagnostic for a ready ticket left unclaimed by conflicting labels. */
export function profileConflictDiagnostic(
  ticketId: string,
  matches: readonly { name: string; label: string }[],
): string {
  return (
    `ticket ${ticketId}: labels ${andList(matches.map((m) => displayName(m.label)))} select ` +
    `more than one profile (${matches.map((m) => displayName(m.name)).join(', ')}) — ` +
    `remove all but one profile label to make it claimable`
  )
}
