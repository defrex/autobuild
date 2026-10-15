/** Signed lifecycle-bound execution grants, internal owner delegation and admin.
 * Historical resource/deployment/operator scopes remain decodable for tests
 * and migration diagnostics; hosted machine gates reject those retired forms.
 * Project credentials are opaque stored secrets, not these stateless tokens.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { viaSchema, type Via } from '../../events/envelope'

export interface LegacyBuildTokenScope {
  /** Retained wire compatibility for all existing build-scoped tokens. */
  build: string
  session: string
  exp: number
}

export interface ResourceTokenScope {
  resource: {
    kind: 'build' | 'repo' | 'session'
    id: string
  }
  session: string
  exp: number
  /** Delegated-write attribution (§15.1): when present, the hosted service
   * stamps this via onto human-actor event writes and rejects writes claiming
   * a via the token does not carry. A session resource token's authority is
   * exactly its one session. */
  via?: Via
}

/** Human operator authority is deliberately disjoint from raw store authority.
 * The signed nonblank user claim attributes every operator API event. An
 * unscoped operator token carries no via claim, so any write claiming a via
 * under it is rejected. */
export interface OperatorTokenScope {
  operator: { user: string }
  exp: number
  via?: Via
}

/** Deployment authority used by dispatchers for raw store and hosted ticket
 * routes. It intentionally does not grant access to attributed operator APIs. */
export interface DeploymentTokenScope {
  operator: true
  session: string
  exp: number
}

/** Includes retired wire shapes for recognition, never server authorization. */
export interface InternalOperatorTokenScope {
  version: 1
  internalOperator: { user: string; repo: string }
  exp: number
  via?: Via
}
export interface AdminTokenScope {
  version: 1
  ownerAdmin: { user: string }
  exp: number
}
export interface DelegatedTokenScope {
  version: 2
  delegation: {
    repo: string
    kind: 'build-runner' | 'build-phase' | 'harvest-runner' | 'harvest-phase'
    id: string
    anchor: number
    session?: string
    execution?: string
    leaseHolder?: string
  }
}

export type TokenScope =
  | DelegatedTokenScope
  | InternalOperatorTokenScope
  | AdminTokenScope
  | LegacyBuildTokenScope
  | ResourceTokenScope
  | OperatorTokenScope
  | DeploymentTokenScope

const commonScope = {
  session: z.string().min(1),
  exp: z.number().int(),
}
const exactIdentity = z
  .string()
  .min(1)
  .refine((value) => value !== '*')
const delegatedClaims = z
  .strictObject({
    repo: exactIdentity,
    kind: z.enum(['build-runner', 'build-phase', 'harvest-runner', 'harvest-phase']),
    id: exactIdentity,
    anchor: z.number().int().positive(),
    session: exactIdentity.optional(),
    execution: exactIdentity.optional(),
    leaseHolder: exactIdentity.optional(),
  })
  .refine(
    (claims) =>
      claims.kind.endsWith('-phase') === (claims.session !== undefined) &&
      claims.kind.startsWith('harvest') === (claims.execution !== undefined),
  )
const tokenScopeSchema = z.union([
  z.strictObject({ version: z.literal(2), delegation: delegatedClaims }),
  z.strictObject({
    version: z.literal(1),
    internalOperator: z.strictObject({ user: z.string().trim().min(1), repo: z.string().min(1) }),
    exp: z.number().int(),
    via: viaSchema.optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    ownerAdmin: z.strictObject({ user: z.string().trim().min(1) }),
    exp: z.number().int(),
  }),
  z.strictObject({ build: z.string().min(1), ...commonScope }),
  z.strictObject({
    resource: z.strictObject({
      kind: z.enum(['build', 'repo', 'session']),
      id: z.string().min(1),
    }),
    ...commonScope,
    via: viaSchema.optional(),
  }),
  z.strictObject({
    operator: z.strictObject({ user: z.string().trim().min(1) }),
    exp: z.number().int(),
    via: viaSchema.optional(),
  }),
  z.strictObject({ operator: z.literal(true), ...commonScope }),
])

export function tokenResource(scope: TokenScope): {
  kind: 'build' | 'repo' | 'session' | 'admin' | 'operator' | 'deployment'
  id: string
} {
  if ('delegation' in scope)
    return {
      kind: scope.delegation.kind.startsWith('build') ? 'build' : 'repo',
      id: scope.delegation.kind.startsWith('build') ? scope.delegation.id : scope.delegation.repo,
    }
  if ('ownerAdmin' in scope) return { kind: 'admin', id: '*' }
  if ('internalOperator' in scope) return { kind: 'operator', id: scope.internalOperator.user }
  if ('operator' in scope) {
    return scope.operator === true
      ? { kind: 'deployment', id: '*' }
      : { kind: 'operator', id: scope.operator.user }
  }
  if ('build' in scope) {
    return scope.build === '*' ? { kind: 'admin', id: '*' } : { kind: 'build', id: scope.build }
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
 * 401). Version-2 grants deliberately have no fixed expiration: the service
 * must additionally validate their registered project and durable lifecycle.
 * The signature compare is timing-safe via `crypto.timingSafeEqual`.
 */
export function verifyToken(secret: string, token: string, now: Date): TokenScope | null {
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
  if ('exp' in scope.data && scope.data.exp <= now.getTime()) return null
  return scope.data
}
