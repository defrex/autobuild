import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '../../store/remote/version'
import { ticketGrantResponseSchema } from './remote-protocol'

export async function ticketGrantRequest(url: string, token: string, input: unknown) {
  const response = await fetch(`${url.replace(/\/+$/, '')}/tickets/grants`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
    },
    body: JSON.stringify(input),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  })
  // Teardown can race guest/host cleanup; an ended grant is already revoked.
  if (
    response.status === 401 &&
    typeof input === 'object' &&
    input !== null &&
    'action' in input &&
    input.action === 'revoke'
  )
    return { ok: true }
  if (!response.ok)
    throw new Error(
      `Ticket grant request failed (${response.status}); refusing project-authority fallback`,
    )
  return response.json()
}
export async function issueTicketGrant(
  url: string,
  token: string,
  repo: string,
  execution: string,
  kind: 'runner' | 'phase',
) {
  return ticketGrantResponseSchema.parse(
    await ticketGrantRequest(url, token, { action: 'issue', repo, execution, kind }),
  )
}
