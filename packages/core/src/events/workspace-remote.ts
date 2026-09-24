import type { EventPayload } from './payloads'

/** Whether the workspace this payload records publishes remotely, per the
 * durable marker recorded at provision (AUT-406). The legacy provider-name
 * fallback is gone (AUT-505): journals written before the marker existed are
 * read as local — the marker audit proved every unfinished hosted journal
 * carries the marker, and the fallback's only hit was a set of unrecoverable
 * orphan journals from the legacy repository identity. */
export function isRemoteWorkspace(
  payload: Pick<EventPayload<'workspace.provisioned'>, 'provider' | 'remote'>,
): boolean {
  return payload.remote === true
}
