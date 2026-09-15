/**
 * The wire protocol of the remote BuildStore (SPEC §7.2 adapter 2): JSON
 * bodies, artifact content as base64, errors as `{error, kind}`. Server
 * (server.ts) and client (client.ts) parse the exact same schemas, so the
 * wire can never drift between the two halves.
 *
 * ── Atomic deposits over the wire (D6, §8.5) ─────────────────────────────
 * `BuildStore.appendWithArtifacts` takes a `makeEvent` callback — not
 * serializable. The wire convention:
 *
 *   client sends  { artifacts: [{kind, contentBase64, metadata?}, …],
 *                   event: { actor, type, payload } }
 *
 * where the payload may embed placeholder refs `{kind, rev: -(index+1)}`
 * pointing at the request's artifacts array (the client runs `makeEvent`
 * against sentinel metas carrying those negative revisions). The server
 * calls the backing store's `appendWithArtifacts` and, inside its
 * `makeEvent`, walks the payload substituting the really-assigned revisions
 * for the negative placeholders — so deposit + event stay one atomic
 * operation server-side.
 *
 * This covers the system's only usage pattern: payloads embed deposited
 * refs as `{kind, rev}` objects (§15.2 — events carry facts and refs).
 * Arbitrary computation over the assigned revisions inside `makeEvent`
 * (e.g. `rev + 1`, string interpolation) is unsupported by design.
 */
import { z } from 'zod'
import { actorSchema } from '../../events/envelope'
import { ticketRefSchema } from '../../ontology'
import type { ArtifactMeta, RepositoryArtifactMeta, SessionArtifactMeta } from '../types'

// ── Errors (D6: errors as feedback over the wire) ────────────────────────────

export const errorKindSchema = z.enum(['validation', 'not-found', 'auth', 'conflict', 'internal'])
export type ErrorKind = z.infer<typeof errorKindSchema>

export const errorBodySchema = z.object({
  error: z.string(),
  kind: errorKindSchema,
})
export type ErrorBody = z.infer<typeof errorBodySchema>

// ── Builds ───────────────────────────────────────────────────────────────────

export const newBuildBodySchema = z.object({
  slug: z.string().min(1),
  repo: z.string().min(1),
  // Additive optional identity: the build repository's normalized git origin.
  // Old servers strip it on create (path-only fallback) and never return it;
  // old clients never send it. No protocol-version bump.
  repoOrigin: z.string().optional(),
  ticket: ticketRefSchema.optional(),
  branch: z.string().min(1).optional(),
})

export const buildRecordWireSchema = z.object({
  slug: z.string(),
  repo: z.string(),
  repoOrigin: z.string().optional(),
  ticket: ticketRefSchema.optional(),
  branch: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lease: z.object({ holder: z.string(), expiresAt: z.string() }).optional(),
  heartbeatAt: z.string().optional(),
})
export const buildRecordListSchema = z.array(buildRecordWireSchema)

// ── Events ───────────────────────────────────────────────────────────────────

/**
 * Deliberately loose: the ontology is enforced by `validateEventWrite` in
 * the *backing store* (§8), so its precise EventValidationError message —
 * the agent feedback D6 exists for — survives the wire instead of being
 * shadowed by a duplicate wire-schema error.
 */
export const eventWriteWireSchema = z.object({
  actor: z.unknown(),
  type: z.string().min(1),
  payload: z.unknown(),
})

export const eventEnvelopeWireSchema = z.object({
  build: z.string(),
  seq: z.number().int().positive(),
  ts: z.string(),
  actor: actorSchema,
  type: z.string(),
  payload: z.unknown(),
})
export const eventListSchema = z.array(eventEnvelopeWireSchema)

export const conditionalEventBodySchema = z.object({
  expectedSeq: z.number().int().nonnegative(),
  event: eventWriteWireSchema,
})
export const conditionalEventResponseSchema = eventEnvelopeWireSchema.nullable()

// ── Repository journals ─────────────────────────────────────────────────────

export const ensureRepoBodySchema = z.object({ repo: z.string().min(1) })
export const repositoryRecordWireSchema = z.object({
  repo: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  lease: z.object({ holder: z.string(), expiresAt: z.string() }).optional(),
  heartbeatAt: z.string().optional(),
})

export const repositoryEventEnvelopeWireSchema = z.object({
  repo: z.string(),
  seq: z.number().int().positive(),
  ts: z.string(),
  actor: actorSchema,
  type: z.string(),
  payload: z.unknown(),
})
export const repositoryEventListSchema = z.array(repositoryEventEnvelopeWireSchema)

export const repositoryArtifactMetaWireSchema = z.object({
  repo: z.string(),
  kind: z.string(),
  revision: z.number().int().nonnegative(),
  blobRef: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})
export const repositoryArtifactMetaListSchema = z.array(repositoryArtifactMetaWireSchema)
export const repositoryArtifactGetResponseSchema = z.union([
  z.null(),
  z.object({
    meta: repositoryArtifactMetaWireSchema,
    contentBase64: z.string(),
  }),
])
export const repoDepositsResponseSchema = z.object({
  event: repositoryEventEnvelopeWireSchema,
  artifacts: repositoryArtifactMetaListSchema,
})

// ── Operator sessions (SPEC §7.1.1) ─────────────────────────────────────────

export const newSessionBodySchema = z.object({
  repo: z.string().min(1),
  operator: z.string().min(1),
  title: z.string().optional(),
})

export const sessionRecordWireSchema = z.object({
  id: z.string(),
  repo: z.string(),
  operator: z.string(),
  title: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const sessionRecordListSchema = z.array(sessionRecordWireSchema)

export const sessionEventEnvelopeWireSchema = z.object({
  session: z.string(),
  seq: z.number().int().positive(),
  ts: z.string(),
  actor: actorSchema,
  type: z.string(),
  payload: z.unknown(),
})
export const sessionEventListSchema = z.array(sessionEventEnvelopeWireSchema)

export const sessionArtifactMetaWireSchema = z.object({
  session: z.string(),
  kind: z.string(),
  revision: z.number().int().nonnegative(),
  blobRef: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})
export const sessionArtifactMetaListSchema = z.array(sessionArtifactMetaWireSchema)
export const sessionArtifactGetResponseSchema = z.union([
  z.null(),
  z.object({
    meta: sessionArtifactMetaWireSchema,
    contentBase64: z.string(),
  }),
])
export const sessionDepositsResponseSchema = z.object({
  event: sessionEventEnvelopeWireSchema,
  artifacts: sessionArtifactMetaListSchema,
})

// ── Artifacts ────────────────────────────────────────────────────────────────

export const artifactMetaWireSchema = z.object({
  build: z.string(),
  kind: z.string(),
  revision: z.number().int().nonnegative(),
  blobRef: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})
export const artifactMetaListSchema = z.array(artifactMetaWireSchema)

export const putArtifactBodySchema = z.object({
  kind: z.string().min(1),
  contentBase64: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

/** GET …/artifacts: JSON `null` when the kind (or rev) is absent (§7.2). */
export const artifactGetResponseSchema = z.union([
  z.null(),
  z.object({
    meta: artifactMetaWireSchema,
    contentBase64: z.string(),
  }),
])

// ── Atomic deposits (see module header) ──────────────────────────────────────

export const depositsBodySchema = z.object({
  artifacts: z.array(putArtifactBodySchema),
  event: eventWriteWireSchema,
})

export const depositsResponseSchema = z.object({
  event: eventEnvelopeWireSchema,
  artifacts: artifactMetaListSchema,
})

// ── Leases (§7.4, §15.2.6) ───────────────────────────────────────────────────

export const leaseClaimBodySchema = z.object({
  holder: z.string().min(1),
  ttlMs: z.number().int().nonnegative(),
})
export const leaseHolderBodySchema = z.object({ holder: z.string().min(1) })
export const okResponseSchema = z.object({ ok: z.boolean() })

// ── Streams (SPEC §7.6 — the third primitive) ────────────────────────────
//
// Deliberately loose on part contents: the store performs no protocol
// validation on append (assembly at close does that), and `looseObject` —
// not `z.object` — so unknown part keys survive the wire untouched.

export const streamScopeWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('build'), build: z.string().min(1) }),
  z.object({ kind: z.literal('repo'), repo: z.string().min(1) }),
  z.object({ kind: z.literal('session'), session: z.string().min(1) }),
])

export const streamArtifactRefWireSchema = z.object({
  kind: z.string(),
  revision: z.number().int().nonnegative(),
  blobRef: z.string(),
})

export const streamRecordWireSchema = z.object({
  id: z.string(),
  scope: streamScopeWireSchema,
  label: z.string(),
  format: z.string(),
  status: z.enum(['open', 'closed']),
  createdAt: z.string(),
  closedAt: z.string().optional(),
  outcome: z.enum(['completed', 'aborted']).optional(),
  artifact: streamArtifactRefWireSchema.optional(),
})
export const streamRecordListSchema = z.array(streamRecordWireSchema)

export const createStreamBodySchema = z.object({ label: z.string().min(1) })
export const closeStreamBodySchema = z.object({ outcome: z.enum(['completed', 'aborted']) })

export const streamPartWireSchema = z.looseObject({ type: z.string().min(1) })
export const appendStreamBodySchema = z.object({
  parts: z.array(streamPartWireSchema).min(1),
})

export const streamChunkWireSchema = z.object({
  stream: z.string(),
  seq: z.number().int().positive(),
  ts: z.string(),
  parts: z.array(z.record(z.string(), z.unknown())),
})
export const streamReadWireSchema = z.object({
  chunks: z.array(streamChunkWireSchema),
  status: z.enum(['open', 'closed']),
  outcome: z.enum(['completed', 'aborted']).optional(),
  artifact: streamArtifactRefWireSchema.optional(),
})

// ── Base64 content encoding ──────────────────────────────────────────────────

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export function decodeBase64(text: string): Uint8Array {
  if (
    text.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  ) {
    throw new Error('artifact content is not valid base64')
  }
  const bytes = new Uint8Array(Buffer.from(text, 'base64'))
  if (encodeBase64(bytes) !== text) throw new Error('artifact content is not valid base64')
  return bytes
}

// ── Placeholder refs for atomic deposits ─────────────────────────────────────

/** The negative sentinel revision for the deposit at `index`: -(index+1). */
export function placeholderRev(index: number): number {
  return -(index + 1)
}

function isPlaceholderRef(value: unknown): value is { kind: string; rev: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  if (Object.keys(value).length !== 2) return false
  const { kind, rev } = value as { kind?: unknown; rev?: unknown }
  return typeof kind === 'string' && typeof rev === 'number' && Number.isInteger(rev) && rev < 0
}

/**
 * Walk a JSON payload, replacing every placeholder ref `{kind, rev: -(i+1)}`
 * with the deposited artifact's real `{kind, rev}`. An out-of-range
 * placeholder is left untouched — event validation then rejects the negative
 * rev (artifact refs are nonnegative, §15.2), rolling the deposit back.
 */
export function substitutePlaceholderRefs(
  value: unknown,
  deposited: Array<ArtifactMeta | RepositoryArtifactMeta | SessionArtifactMeta>,
): unknown {
  if (isPlaceholderRef(value)) {
    const meta = deposited[-value.rev - 1]
    if (meta === undefined) return value
    return { kind: meta.kind, rev: meta.revision }
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitutePlaceholderRefs(item, deposited))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitutePlaceholderRefs(item, deposited)]),
    )
  }
  return value
}
