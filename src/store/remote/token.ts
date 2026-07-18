/**
 * HMAC-scoped store tokens (SPEC §8.1 [D8]): "the token is scoped to this
 * build and session — an agent physically cannot append to another build's
 * log or read another build's artifacts". Least privilege comes from the
 * runner minting a narrow token, not from prompt instructions.
 *
 * A token is `base64url(JSON scope) + '.' + base64url(hmac-sha256(secret,
 * payload))`. The scope IS the token — the server keeps no session state;
 * it verifies the signature (timing-safe) and the expiry, then trusts the
 * embedded scope.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export interface LegacyBuildTokenScope {
  /** Retained wire compatibility for all existing build-scoped tokens. */
  build: string
  session: string
  exp: number
}

export interface ResourceTokenScope {
  resource: {
    kind: 'build' | 'repo'
    id: string
  }
  session: string
  exp: number
}

/** Legacy build scopes remain valid; repository harvest sessions use the
 * explicit resource form so a repo token cannot read any build stream. */
export type TokenScope = LegacyBuildTokenScope | ResourceTokenScope

const commonScope = {
  session: z.string().min(1),
  exp: z.number().int(),
}
const tokenScopeSchema = z.union([
  z.strictObject({ build: z.string().min(1), ...commonScope }),
  z.strictObject({
    resource: z.strictObject({
      kind: z.enum(['build', 'repo']),
      id: z.string().min(1),
    }),
    ...commonScope,
  }),
])

export function tokenResource(scope: TokenScope): {
  kind: 'build' | 'repo' | 'admin'
  id: string
} {
  if ('build' in scope) {
    return scope.build === '*'
      ? { kind: 'admin', id: '*' }
      : { kind: 'build', id: scope.build }
  }
  return scope.resource
}

function sign(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

export function mintToken(secret: string, scope: TokenScope): string {
  const payload = Buffer.from(JSON.stringify(scope), 'utf8').toString('base64url')
  return `${payload}.${sign(secret, payload).toString('base64url')}`
}

/**
 * Bad signature, malformed token, unparseable scope, or expired → null —
 * verification never explains itself to the caller (the server maps null to
 * 401). The signature compare is timing-safe via `crypto.timingSafeEqual`.
 */
export function verifyToken(
  secret: string,
  token: string,
  now: Date,
): TokenScope | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, signature] = parts as [string, string]
  const expected = sign(secret, payload)
  let provided: Buffer
  try {
    provided = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const scope = tokenScopeSchema.safeParse(raw)
  if (!scope.success) return null
  if (scope.data.exp <= now.getTime()) return null
  return scope.data
}
