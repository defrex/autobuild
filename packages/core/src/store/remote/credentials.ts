import { delegateCredentialResponseSchema, type DelegateCredentialTarget } from './protocol'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from './version'

/** Fail closed: a remote execution must never fall back to its parent token. */
export async function delegateCredential(
  storeRef: string,
  token: string | undefined,
  target: DelegateCredentialTarget,
): Promise<string> {
  if (!token) throw new Error('credential delegation requires parent authority')
  const response = await fetch(`${storeRef.replace(/\/$/, '')}/credentials/delegate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
    },
    body: JSON.stringify(target),
  })
  if (!response.ok) throw new Error(`credential delegation refused (${response.status})`)
  return delegateCredentialResponseSchema.parse(await response.json()).token
}
