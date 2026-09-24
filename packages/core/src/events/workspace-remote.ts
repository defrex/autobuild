import type { EventPayload } from './payloads'

/** Whether the workspace this payload records publishes remotely, per the
 * marker recorded at provision. Journals written before the marker existed
 * fall back to the legacy provider-name reading — the only name comparison
 * among the remote/local decisions (removed in AUT-505). */
export function isRemoteWorkspace(
  payload: Pick<EventPayload<'workspace.provisioned'>, 'provider' | 'remote'>,
): boolean {
  if (payload.remote !== undefined) return payload.remote
  return payload.provider === 'vercel-sandbox'
}
