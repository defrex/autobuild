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
import type { ArtifactMeta, RepositoryArtifactMeta } from '../types'

// ── Errors (D6: errors as feedback over the wire) ────────────────────────────

export const errorKindSchema = z.enum([
  'validation',
  'not-found',
  'auth',
  'conflict',
  'internal',
])
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
  ticket: ticketRefSchema.optional(),
  branch: z.string().min(1).optional(),
})

export const buildRecordWireSchema = z.object({
  slug: z.string(),
  repo: z.string(),
  ticket: ticketRefSchema.optional(),
  branch: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lease: z
    .object({ holder: z.string(), expiresAt: z.string() })
    .optional(),
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

// ── Repository journals / harvest ───────────────────────────────────────────

export const ensureRepoBodySchema = z.object({ repo: z.string().min(1) })
export const repositoryRecordWireSchema = z.object({
  repo: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  lease: z.object({ holder: z.string(), expiresAt: z.string() }).optional(),
  heartbeatAt: z.string().optional(),
})

export const harvestEventEnvelopeWireSchema = z.object({
  repo: z.string(),
  seq: z.number().int().positive(),
  ts: z.string(),
  actor: actorSchema,
  type: z.string(),
  payload: z.unknown(),
})
export const harvestEventListSchema = z.array(harvestEventEnvelopeWireSchema)

export const repositoryArtifactMetaWireSchema = z.object({
  repo: z.string(),
  kind: z.string(),
  revision: z.number().int().nonnegative(),
  blobRef: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})
export const repositoryArtifactMetaListSchema = z.array(
  repositoryArtifactMetaWireSchema,
)
export const repositoryArtifactGetResponseSchema = z.union([
  z.null(),
  z.object({
    meta: repositoryArtifactMetaWireSchema,
    contentBase64: z.string(),
  }),
])
export const repoDepositsResponseSchema = z.object({
  event: harvestEventEnvelopeWireSchema,
  artifacts: repositoryArtifactMetaListSchema,
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

// ── Base64 content encoding ──────────────────────────────────────────────────

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export function decodeBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'))
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
  return (
    typeof kind === 'string' &&
    typeof rev === 'number' &&
    Number.isInteger(rev) &&
    rev < 0
  )
}

/**
 * Walk a JSON payload, replacing every placeholder ref `{kind, rev: -(i+1)}`
 * with the deposited artifact's real `{kind, rev}`. An out-of-range
 * placeholder is left untouched — event validation then rejects the negative
 * rev (artifact refs are nonnegative, §15.2), rolling the deposit back.
 */
export function substitutePlaceholderRefs(
  value: unknown,
  deposited: Array<ArtifactMeta | RepositoryArtifactMeta>,
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
      Object.entries(value).map(([key, item]) => [
        key,
        substitutePlaceholderRefs(item, deposited),
      ]),
    )
  }
  return value
}
