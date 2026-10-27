/** Persisted facts are open on reads; producer schemas remain closed on writes. */
import type { z } from 'zod'
import type { Actor } from './envelope'
import type { AbEvent } from './catalog'
import { eventPayloadSchemas } from './payloads'
import { repositoryEventPayloadSchemas, type RepositoryEvent } from './repository'
import {
  buildEventPolicy,
  repositoryEventPolicy,
  compatibilityMetadataSchema,
  type CompatibilityMetadata,
} from './policy'

export interface StoredEvent {
  build?: string
  repo?: string
  seq: number
  ts: string
  actor: Actor
  type: string
  payload: unknown
  compatibility?: CompatibilityMetadata
}

/** Change this revision whenever projection semantics change without new types. */
// Revision 3 retains optional billing-account descriptors in session/attempt projections.
export const READ_DECODER_REVISION = 3
export function catalogIdentity(
  build: Record<string, string> = buildEventPolicy,
  repository: Record<string, string> = repositoryEventPolicy,
): string {
  const sorted = (catalog: Record<string, string>) =>
    Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return new Bun.CryptoHasher('sha256')
    .update(JSON.stringify([READ_DECODER_REVISION, sorted(build), sorted(repository)]))
    .digest('hex')
}
export const READ_CATALOG_IDENTITY = catalogIdentity()

/** Remove only keys reported as unknown by the original schema, then run that
 * schema again. Its required fields, enums and refinements remain authoritative. */
export function projectPayload(schema: z.ZodType, payload: unknown): unknown {
  const projected = structuredClone(payload)
  for (;;) {
    const result = schema.safeParse(projected)
    if (result.success) return result.data
    let removed = false
    for (const issue of removableKeys(result.error.issues)) {
      let object: unknown = projected
      for (const key of issue.path) object = (object as Record<PropertyKey, unknown>)?.[key]
      if (object === null || typeof object !== 'object') continue
      for (const key of issue.keys) {
        if (!Object.hasOwn(object, key)) continue
        delete (object as Record<string, unknown>)[key]
        removed = true
      }
    }
    if (!removed) throw result.error
  }
}
type UnknownKeys = { path: PropertyKey[]; keys: string[] }
function removableKeys(
  issues: readonly z.core.$ZodIssue[],
  prefix: PropertyKey[] = [],
): UnknownKeys[] {
  return issues.flatMap((issue): UnknownKeys[] => {
    const path = [...prefix, ...issue.path]
    if (issue.code === 'unrecognized_keys') return [{ path, keys: issue.keys }]
    if (issue.code !== 'invalid_union') return []
    // Choose one branch that would validate after dropping only added fields;
    // never remove the known fields demanded by another union alternative.
    const branches = issue.errors as unknown as readonly (readonly z.core.$ZodIssue[])[]
    const branch = branches.find((errors) => errors.every(onlyAddedFields))
    return branch ? removableKeys(branch, path) : []
  })
}
function onlyAddedFields(issue: z.core.$ZodIssue): boolean {
  return (
    issue.code === 'unrecognized_keys' ||
    (issue.code === 'invalid_union' &&
      (issue.errors as unknown as readonly (readonly z.core.$ZodIssue[])[]).some((errors) =>
        errors.every(onlyAddedFields),
      ))
  )
}
export function decodeStoredEvent(event: StoredEvent): AbEvent | RepositoryEvent | null {
  const schemas = event.repo === undefined ? eventPayloadSchemas : repositoryEventPayloadSchemas
  const schema = Object.hasOwn(schemas, event.type)
    ? schemas[event.type as keyof typeof schemas]
    : undefined
  const result = schema
    ? ({ ...event, payload: projectPayload(schema, event.payload) } as AbEvent | RepositoryEvent)
    : null
  return result
}
export function projectEvents<E>(events: readonly E[]): readonly E[] {
  return events.flatMap((event) => {
    // Session and already-adapted selector rows are a separate vocabulary.
    if (
      !event ||
      typeof event !== 'object' ||
      !('payload' in event) ||
      !('actor' in event) ||
      (!('build' in event) && !('repo' in event))
    )
      return [event]
    const known = decodeStoredEvent(event as unknown as StoredEvent)
    return known === null ? [] : [known as E]
  })
}
export interface CompatibilityState {
  unknownFacts: number
  decisiveFacts: number
  lastSeq: number
  decisiveBoundary: number
  types: string[]
  writerVersions: string[]
  legacyVersionUnavailable: boolean
  decisiveTypes: string[]
  decisiveWriterVersions: string[]
  decisiveLegacyVersionUnavailable: boolean
}
export function initialCompatibility(): CompatibilityState {
  return {
    unknownFacts: 0,
    decisiveFacts: 0,
    lastSeq: 0,
    decisiveBoundary: 0,
    types: [],
    writerVersions: [],
    legacyVersionUnavailable: false,
    decisiveTypes: [],
    decisiveWriterVersions: [],
    decisiveLegacyVersionUnavailable: false,
  }
}
export function advanceCompatibility(
  state: CompatibilityState,
  events: readonly StoredEvent[],
): void {
  for (const event of events) {
    if (decodeStoredEvent(event) !== null) continue
    state.lastSeq = Math.max(state.lastSeq, event.seq)
    state.unknownFacts++
    const metadata =
      event.compatibility === undefined
        ? undefined
        : compatibilityMetadataSchema.parse(event.compatibility)
    if (!state.types.includes(event.type)) state.types.push(event.type)
    if (metadata && !state.writerVersions.includes(metadata.writerVersion))
      state.writerVersions.push(metadata.writerVersion)
    if (!metadata) state.legacyVersionUnavailable = true
    if (metadata?.classification !== 'advisory') {
      if (!state.decisiveTypes.includes(event.type)) state.decisiveTypes.push(event.type)
      if (metadata && !state.decisiveWriterVersions.includes(metadata.writerVersion))
        state.decisiveWriterVersions.push(metadata.writerVersion)
      if (!metadata) state.decisiveLegacyVersionUnavailable = true
      state.decisiveFacts++
      state.decisiveBoundary = event.seq
    }
  }
}

/** Selector folds also consume deliberately compact/adapted rows. Filter their
 * vocabulary here; strict payload projection happens before adaptation at the
 * persisted-read boundary and in the whole-build reduction. */
export function filterKnownEvents<E>(events: readonly E[]): readonly E[] {
  return events.filter((event) => {
    if (
      !event ||
      typeof event !== 'object' ||
      !('type' in event) ||
      (!('build' in event) && !('repo' in event))
    )
      return true
    const schemas = 'repo' in event ? repositoryEventPayloadSchemas : eventPayloadSchemas
    return typeof event.type === 'string' && Object.hasOwn(schemas, event.type)
  })
}
/** Preserve opaque facts for compatibility-bearing folds after validating all
 * known payloads, before any selector adapts or drops payload fields. */
export function projectStoredEvents<E extends StoredEvent>(events: readonly E[]): E[] {
  return events.map((event) => (decodeStoredEvent(event) ?? event) as E)
}
