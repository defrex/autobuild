/** Named JSON answers over persisted incremental state, resolved against the
 * complete catalog. The event log remains authoritative. */
import { READ_CATALOG_IDENTITY } from '../events/catalog-identity'
import { REDUCERS } from '../kernel/reducer-registry'
import type { SnapshotScope } from './snapshots'
import {
  parseValueRequest,
  readResolvedReducerValue,
  resolveRegisteredValue,
  type ReducerValue,
  type ReducerValueRequest,
  type ReducerValueStorage,
} from './reducer-value-read'

export {
  canonical,
  parseValueRequest,
  readResolvedReducerValue,
  reducerValueRequestSchema,
  reducerValueSchema,
  resolveRegisteredValue,
  type JsonValue,
  type ReducerValue,
  type ReducerValueRequest,
  type ReducerValueStorage,
  type ResolvedReducerValue,
  type ValueCacheRow,
  type ValueCatalogEntry,
} from './reducer-value-read'

export function resolveReducerValue(
  scope: SnapshotScope,
  input: ReducerValueRequest,
  catalogIdentity = READ_CATALOG_IDENTITY,
) {
  const request = parseValueRequest(input)
  const registration = Object.hasOwn(REDUCERS, request.reducer)
    ? REDUCERS[request.reducer]
    : undefined
  return resolveRegisteredValue(scope, request, registration, catalogIdentity)
}

export function readReducerValue(
  scope: SnapshotScope,
  request: ReducerValueRequest,
  storage: ReducerValueStorage,
): Promise<ReducerValue> {
  // Not `async`: returning the inner promise directly keeps the read's
  // microtask timing identical to the single-function body it replaced.
  let resolved: ReturnType<typeof resolveReducerValue>
  try {
    resolved = resolveReducerValue(scope, request)
  } catch (error) {
    return Promise.reject(error)
  }
  return readResolvedReducerValue(resolved, storage)
}
