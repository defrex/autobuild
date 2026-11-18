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
  if (!response.ok) {
    const reason = await refusalReason(response)
    throw new Error(
      `credential delegation refused (${response.status})${reason ? `: ${reason}` : ''}`,
    )
  }
  return delegateCredentialResponseSchema.parse(await response.json()).token
}

const MAX_REASON_LENGTH = 200

/** The server's stated reason for a refusal: the `error` field of a JSON
 * body, else bounded plain text, else empty. Never throws, so an empty or
 * unreadable body cannot mask the refusal itself. */
async function refusalReason(response: Response): Promise<string> {
  let text: string
  try {
    text = (await response.text()).trim()
  } catch {
    return ''
  }
  if (!text) return ''
  try {
    const body: unknown = JSON.parse(text)
    if (body && typeof body === 'object' && 'error' in body) {
      const error = (body as { error: unknown }).error
      if (typeof error === 'string' && error.trim()) return error.trim().slice(0, MAX_REASON_LENGTH)
    }
    return ''
  } catch {
    return text.slice(0, MAX_REASON_LENGTH)
  }
}
