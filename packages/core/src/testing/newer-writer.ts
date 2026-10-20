/** Frozen newer-writer fixture. Persist directly through an adapter fixture;
 * never submit this fact through the older production writer's catalog. */
import type { StoredEvent } from '../events/compatibility'
import { AUTOBUILD_VERSION } from '../store/remote/version'
export const NEWER_EVENT_TYPE = 'future.fixture.control'
export function newerFact(
  seq: number,
  classification: 'advisory' | 'decisive' = 'decisive',
  build = 'mixed',
): StoredEvent {
  return {
    build,
    seq,
    ts: '2026-10-20T12:00:00.000Z',
    actor: { kind: 'kernel' },
    type: NEWER_EVENT_TYPE,
    payload: { nested: { future: true } },
    compatibility: { writerVersion: AUTOBUILD_VERSION, classification },
  }
}

/** Models bytes committed by a separate newer writer, bypassing the older
 * writer only inside test fixtures. Does not alter production validation. */
export function seedNewerMemoryFact(
  store: import('../store/memory').MemoryBuildStore,
  event: StoredEvent,
): void {
  const collection = event.repo === undefined ? 'builds' : 'repos'
  const resource = event.repo ?? event.build!
  const records = (store as unknown as Record<string, Map<string, { events: StoredEvent[] }>>)[
    collection
  ]!
  const record = records.get(resource)
  if (!record || event.seq !== record.events.length + 1)
    throw new Error('invalid newer-writer fixture sequence')
  record.events.push(structuredClone(event))
}
