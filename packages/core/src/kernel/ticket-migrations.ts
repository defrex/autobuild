import { readRepositoryFacts } from '../store/reduced-reads'
import type { TicketRef } from '../ontology'
import type { Actor } from '../events/envelope'
import type { RepositoryEvent, RepositoryEventPayload } from '../events/repository'
import { validateRepositoryEventWrite } from '../events/repository'
import type { BuildStore } from '../store/types'
import { defineReducer } from './incremental'

type Migration = RepositoryEventPayload<'tickets.migration-recorded'>
export interface TicketMigrations {
  migrations: Migration[]
}
const key = (ref: TicketRef) => JSON.stringify([ref.source, ref.id])
function stable(value: Migration): string {
  return JSON.stringify([value.from, value.to, Object.entries(value.mapping).sort()])
}
function add(state: TicketMigrations, migration: Migration) {
  const previous = state.migrations.find((m) => m.identity === migration.identity)
  if (previous) {
    if (stable(previous) !== stable(migration))
      throw new Error(`conflicting ticket migration ${migration.identity}`)
    return
  }
  for (const old of state.migrations)
    if (old.from !== old.to && migration.from !== migration.to && old.from === migration.from)
      for (const [id, next] of Object.entries(migration.mapping))
        if (Object.hasOwn(old.mapping, id) && (old.to !== migration.to || old.mapping[id] !== next))
          throw new Error(`conflicting ticket migration for ${migration.from}:${id}`)
  state.migrations.push(migration)
  // Reject cycles even before any build consults the evidence.
  for (const m of state.migrations)
    for (const id of Object.keys(m.mapping)) walk(state, { source: m.from, id })
}
function walk(
  state: TicketMigrations,
  original: TicketRef,
  destination?: string,
  build = 'unknown',
): TicketRef {
  let current = original
  const visited = new Set<string>()
  while (current.source !== destination) {
    if (visited.has(key(current)))
      throw new Error(`ticket migration cycle at ${current.source}:${current.id}`)
    visited.add(key(current))
    const routes = state.migrations.filter((m) => m.from === current.source && m.from !== m.to)
    const route = routes.find((m) => Object.hasOwn(m.mapping, current.id))
    if (!route) {
      if (destination === undefined) return current
      throw new Error(
        `build ${build} ticket ${original.source}:${original.id}: ${routes.length ? 'recorded migration does not cover id' : 'configured ticket source differs from the frozen node source'}; record continuity with ab ticket migration record <export-dir>`,
      )
    }
    if (route.to === current.source && route.mapping[current.id] === current.id) return current
    current = { ...current, source: route.to, id: route.mapping[current.id]! }
  }
  return current
}
export const ticketMigrationsReducer = defineReducer<
  TicketMigrations,
  RepositoryEvent,
  TicketMigrations
>({
  version: 1,
  initial: () => ({ migrations: [] }),
  fold(acc, events) {
    for (const event of events)
      if (event.type === 'tickets.migration-recorded') add(acc, event.payload)
  },
  finish: (acc) => acc,
})
export function resolveTicketRef(
  state: TicketMigrations,
  ref: TicketRef,
  destination: string,
  build?: string,
): TicketRef {
  // Preserve the pre-existing database/hosted adapter compatibility.
  const hosted = destination === 'hosted' || destination === 'database'
  const compatible = ref.source === 'database' && hosted ? { ...ref, source: 'hosted' } : ref
  const current = walk(
    state,
    compatible,
    destination === 'database' ? 'hosted' : destination,
    build,
  )
  return destination === 'database' ? { ...current, source: 'database' } : current
}
export function migrationIdentity(state: TicketMigrations, destination: string) {
  return (ref: TicketRef, build?: string): string => {
    try {
      return key(resolveTicketRef(state, ref, destination, build))
    } catch (error) {
      if (state.migrations.some((m) => m.from === ref.source && m.from !== m.to)) throw error
      return key(ref)
    }
  }
}
/** Comparison only for all-history scans. Uncovered history remains in its
 * original namespace and cannot alias a current-source ticket. Live claims,
 * frozen membership and current-ticket operations must use strict resolution. */
export function historicalTicketIdentity(state: TicketMigrations, destination: string) {
  const identity = migrationIdentity(state, destination)
  return (ref: TicketRef, build?: string): string => {
    try {
      return identity(ref, build)
    } catch {
      return key(ref)
    }
  }
}
export async function readTicketMigrations(
  store: BuildStore,
  repo: string,
): Promise<TicketMigrations> {
  return (await readRepositoryFacts(store, repo)).value.ticketMigrations
}
export async function currentTicketRef(
  store: BuildStore,
  repo: string,
  destination: string,
  ref: TicketRef,
  build?: string,
) {
  return resolveTicketRef(await readTicketMigrations(store, repo), ref, destination, build)
}
export async function recordTicketMigration(
  store: BuildStore,
  repo: string,
  actor: Actor,
  migration: Migration,
) {
  validateRepositoryEventWrite({ actor, type: 'tickets.migration-recorded', payload: migration })
  const state = structuredClone(await readTicketMigrations(store, repo))
  const repeated = state.migrations.some((m) => m.identity === migration.identity)
  add(state, migration)
  if (!repeated)
    await store.appendRepo(repo, { actor, type: 'tickets.migration-recorded', payload: migration })
}
