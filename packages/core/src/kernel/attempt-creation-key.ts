// Server-only: `node:crypto` must stay out of the optimization selectors the
// browser dashboards bundle.
import { createHash } from 'node:crypto'

/**
 * The idempotency key for the attempt ticket a proposal files: an RFC 4122
 * version-4-formatted UUID derived from the node and proposal, so a retried
 * filing adopts the ticket an earlier attempt created. Every ticket source
 * accepts it (Linear requires a v4 UUID).
 */
export function attemptCreationKey(repo: string, node: string, proposal: string): string {
  const hash = createHash('sha256')
    .update(`autobuild-attempt\u0000${repo}\u0000${node}\u0000${proposal}`)
    .digest()
  const bytes = Uint8Array.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
