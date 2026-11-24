import { createHash } from 'node:crypto'

/** Git's object id for a blob holding `bytes`: the hash of `blob <n>\0` plus
 * the bytes. SHA-1 for 40-hex ids, SHA-256 for 64-hex object-format ids. */
export function gitBlobOid(bytes: Uint8Array, format: 'sha1' | 'sha256' = 'sha1'): string {
  const hash = createHash(format)
  hash.update(`blob ${bytes.byteLength}\0`)
  hash.update(bytes)
  return hash.digest('hex')
}

/** True when `bytes` are exactly the blob `oid` names. */
export function matchesGitBlobOid(oid: string, bytes: Uint8Array): boolean {
  return gitBlobOid(bytes, oid.length === 64 ? 'sha256' : 'sha1') === oid
}
