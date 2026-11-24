/**
 * Repository agent context: the dispatcher's durable record of the base
 * branch's installed skills (`.agents/skills`, `.claude/skills`) and agent
 * instructions (`AGENTS.md` / `CLAUDE.md`, root and nested, plus the files
 * they import by `@path`), taken at one base commit.
 *
 * Three repository artifact families carry it, all retention-managed
 * (`store/retention.ts`) and all read only at their latest revision:
 *
 * - `agent-context` — the record: gzip-compressed canonical JSON. A new
 *   revision is deposited only when its content digest changes.
 * - `agent-context-head` — a ~1 KiB pointer naming the last base head the
 *   capture handled, the input fingerprint, and any standing diagnostic.
 * - `agent-context-cache.<i>` — continuation slots holding blob bytes an
 *   interrupted capture already fetched, so a fresh process resumes instead
 *   of refetching. Valid only when their `captureId` matches the pointer's.
 *
 * Reading the record (`readAgentContext`) is one latest-revision artifact
 * read, whatever the number of stored revisions.
 */
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { z } from 'zod'
import {
  AGENT_CONTEXT_ARTIFACT,
  AGENT_CONTEXT_HEAD_ARTIFACT,
  agentContextCacheKind,
} from './retention'
import type { BuildStore, RepositoryArtifactMeta } from './types'

export { AGENT_CONTEXT_ARTIFACT, AGENT_CONTEXT_HEAD_ARTIFACT, agentContextCacheKind }

const MIB = 1024 * 1024

/** Encoded bound: gzip-encoded record bytes, below the hosted artifact ceiling. */
export const AGENT_CONTEXT_MAX_BYTES = 2.25 * MIB
/** Raw input bound: captured blob bytes, which bounds every reader's decode. */
export const AGENT_CONTEXT_MAX_RAW_BYTES = 32 * MIB
/** Continuation packing size: serialized part bytes per slot (a storage
 * packing size, never a limit on the record). */
export const AGENT_CONTEXT_CACHE_SLOT_PAYLOAD = 1.75 * MIB
/** Enough slots for the raw input bound's base64 encoding. */
export const AGENT_CONTEXT_CACHE_SLOTS = Math.ceil(
  (AGENT_CONTEXT_MAX_RAW_BYTES * 4) / 3 / AGENT_CONTEXT_CACHE_SLOT_PAYLOAD,
)
/** Decoded-size ceiling for any record a reader accepts. */
export const AGENT_CONTEXT_MAX_DECODED_BYTES =
  Math.ceil((AGENT_CONTEXT_MAX_RAW_BYTES * 4) / 3) + MIB
/** Per-part envelope cost counted against a slot's payload (oid, offset,
 * JSON punctuation), so a slot of many tiny parts still stays in bounds. */
export const AGENT_CONTEXT_CACHE_PART_OVERHEAD = 128

const content = {
  oid: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  text: z.string().optional(),
  base64: z.string().optional(),
}

const skillFileSchema = z.strictObject({ path: z.string().min(1), ...content })
const skillSchema = z.strictObject({
  name: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  files: z.array(skillFileSchema),
})
const instructionSchema = z.strictObject({
  paths: z.array(z.string().min(1)).min(1),
  directory: z.string(),
  ...content,
  imports: z.array(z.string()),
})
const importSchema = z.strictObject({
  path: z.string().min(1),
  importedBy: z.array(z.string()).min(1),
  ...content,
  imports: z.array(z.string()),
})
export const AGENT_CONTEXT_OMISSION_REASONS = [
  'outside-repository',
  'dangling',
  'submodule',
  'link-depth',
] as const
export const agentContextRecordSchema = z.strictObject({
  version: z.literal(1),
  commit: z.string().min(1),
  baseBranch: z.string().min(1),
  skills: z.array(skillSchema),
  instructions: z.array(instructionSchema),
  imports: z.array(importSchema),
  links: z.array(z.strictObject({ path: z.string(), target: z.string() })),
  omitted: z.array(
    z.strictObject({ path: z.string(), reason: z.enum(AGENT_CONTEXT_OMISSION_REASONS) }),
  ),
})

export type AgentContextRecord = z.infer<typeof agentContextRecordSchema>
export type AgentContextSkill = AgentContextRecord['skills'][number]
export type AgentContextInstruction = AgentContextRecord['instructions'][number]
export type AgentContextImport = AgentContextRecord['imports'][number]
export type AgentContextOmission = AgentContextRecord['omitted'][number]
export interface AgentContextContent {
  oid: string
  bytes: number
  text?: string
  base64?: string
}

const contributorSchema = z.strictObject({ path: z.string(), bytes: z.number() })
export const agentContextDiagnosticSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('oversize'),
    commit: z.string(),
    bound: z.number(),
    bytes: z.number(),
    largest: z.array(contributorSchema),
  }),
  z.strictObject({
    kind: z.literal('raw-oversize'),
    commit: z.string(),
    rawBound: z.number(),
    rawBytes: z.number(),
    largest: z.array(contributorSchema),
  }),
  z.strictObject({ kind: z.literal('tree-unlistable'), commit: z.string(), directory: z.string() }),
  z.strictObject({
    kind: z.literal('capture-failed'),
    commit: z.string().optional(),
    message: z.string(),
  }),
  z.strictObject({ kind: z.literal('unavailable'), message: z.string() }),
])
export type AgentContextDiagnostic = z.infer<typeof agentContextDiagnosticSchema>

export const agentContextPointerSchema = z.strictObject({
  version: z.literal(1),
  branch: z.string().min(1),
  /** The last base head fully handled; null before the first completes. */
  observed: z.string().nullable(),
  /** Input fingerprint of `observed`; null before the first completes. */
  key: z.string().nullable(),
  /** Paths outside the fingerprint's fixed set that the last assembly probed. */
  dependencies: z.array(z.string()),
  revision: z.number().int().nonnegative().optional(),
  digest: z.string().optional(),
  diagnostic: agentContextDiagnosticSchema.optional(),
  pending: z
    .strictObject({
      head: z.string(),
      captureId: z.string(),
      slots: z.number().int().positive(),
    })
    .optional(),
})
export type AgentContextPointer = z.infer<typeof agentContextPointerSchema>

const cachePartSchema = z.strictObject({
  oid: z.string().min(1),
  offset: z.number().int().nonnegative(),
  base64: z.string(),
})
export const agentContextCacheSlotSchema = z.strictObject({
  version: z.literal(1),
  captureId: z.string().min(1),
  slot: z.number().int().nonnegative(),
  parts: z.array(cachePartSchema),
})
export type AgentContextCachePart = z.infer<typeof cachePartSchema>
export type AgentContextCacheSlot = z.infer<typeof agentContextCacheSlotSchema>

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/** `text` when the bytes are exact UTF-8 (BOM kept), otherwise `base64`. */
export function contentFields(bytes: Uint8Array): { text: string } | { base64: string } {
  try {
    const text = utf8.decode(bytes)
    if (Buffer.from(encoder.encode(text)).equals(Buffer.from(bytes))) return { text }
  } catch {
    // Not UTF-8: fall through.
  }
  return { base64: Buffer.from(bytes).toString('base64') }
}

/** The exact bytes a captured entry holds. */
export function contentBytes(entry: AgentContextContent): Uint8Array {
  if (entry.text !== undefined) return encoder.encode(entry.text)
  return new Uint8Array(Buffer.from(entry.base64 ?? '', 'base64'))
}

/** Captured blob bytes: every skill file, instruction file and import. */
export function agentContextRawBytes(record: AgentContextRecord): number {
  let total = 0
  for (const skill of record.skills) for (const file of skill.files) total += file.bytes
  for (const entry of record.instructions) total += entry.bytes
  for (const entry of record.imports) total += entry.bytes
  return total
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Content identity: the canonical JSON without `commit`, so two commits
 * whose captured content is identical share one digest. */
export function agentContextDigest(record: AgentContextRecord): string {
  const { commit: _commit, ...rest } = record
  return sha256(JSON.stringify(rest))
}

export interface EncodedAgentContext {
  content: Uint8Array
  digest: string
  rawBytes: number
}

export function encodeAgentContext(record: AgentContextRecord): EncodedAgentContext {
  return {
    content: new Uint8Array(gzipSync(JSON.stringify(record))),
    digest: agentContextDigest(record),
    rawBytes: agentContextRawBytes(record),
  }
}

function gunzipBounded(bytes: Uint8Array, limit: number, what: string): string {
  let raw: Buffer
  try {
    raw = gunzipSync(bytes, { maxOutputLength: limit })
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
      throw new Error(`${what} decodes beyond ${limit} bytes`)
    throw error
  }
  return raw.toString('utf8')
}

/** Decode a stored record. Refuses one that inflates past
 * `AGENT_CONTEXT_MAX_DECODED_BYTES`, so no reader can be made to allocate
 * without bound by a hostile record. */
export function decodeAgentContext(
  bytes: Uint8Array,
  limit = AGENT_CONTEXT_MAX_DECODED_BYTES,
): AgentContextRecord {
  return agentContextRecordSchema.parse(
    JSON.parse(gunzipBounded(bytes, limit, 'agent-context record')),
  )
}

export function encodeAgentContextCache(slot: AgentContextCacheSlot): Uint8Array {
  return new Uint8Array(gzipSync(JSON.stringify(slot)))
}

export function decodeAgentContextCache(bytes: Uint8Array): AgentContextCacheSlot {
  return agentContextCacheSlotSchema.parse(
    JSON.parse(gunzipBounded(bytes, 2 * AGENT_CONTEXT_CACHE_SLOT_PAYLOAD + MIB, 'cache slot')),
  )
}

export function encodeAgentContextPointer(pointer: AgentContextPointer): string {
  return JSON.stringify(agentContextPointerSchema.parse(pointer))
}

export function decodeAgentContextPointer(bytes: Uint8Array): AgentContextPointer {
  return agentContextPointerSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
}

/** The latest agent-context record: one latest-revision artifact read, never
 * a listing, so its cost is the same at 1 and at 1,000 stored revisions. */
export async function readAgentContext(
  store: Pick<BuildStore, 'getRepoArtifact'>,
  repo: string,
): Promise<{ record: AgentContextRecord; meta: RepositoryArtifactMeta } | null> {
  const artifact = await store.getRepoArtifact(repo, AGENT_CONTEXT_ARTIFACT)
  if (!artifact) return null
  return { record: decodeAgentContext(artifact.content), meta: artifact.meta }
}

export async function readAgentContextPointer(
  store: Pick<BuildStore, 'getRepoArtifact'>,
  repo: string,
): Promise<AgentContextPointer | null> {
  const artifact = await store.getRepoArtifact(repo, AGENT_CONTEXT_HEAD_ARTIFACT)
  return artifact ? decodeAgentContextPointer(artifact.content) : null
}

function partCost(part: AgentContextCachePart): number {
  return part.base64.length + AGENT_CONTEXT_CACHE_PART_OVERHEAD
}

function slotCost(slot: AgentContextCacheSlot): number {
  let total = 0
  for (const part of slot.parts) total += partCost(part)
  return total
}

/**
 * Pack blob bytes into continuation slots. `previous` are the live slots of
 * the same capture, in slot order: every full one is kept untouched, the
 * last one is rewritten only when it has room, and new slots are appended
 * after it. A blob larger than the space left is split by `offset` across
 * slots (at multiples of 3 bytes, so each part's base64 is exact). Slot count
 * therefore follows the live bytes, never the number of invocations.
 * `rewritten` lists the slot indexes the caller must write.
 */
export function packContinuation(
  captureId: string,
  previous: readonly AgentContextCacheSlot[],
  blobs: readonly { oid: string; bytes: Uint8Array }[],
  payload = AGENT_CONTEXT_CACHE_SLOT_PAYLOAD,
): { slots: AgentContextCacheSlot[]; rewritten: number[] } {
  const minimum = AGENT_CONTEXT_CACHE_PART_OVERHEAD + 4
  if (payload < minimum) throw new Error(`slot payload must be at least ${minimum}`)
  const slots = previous.map((slot) => ({ ...slot, parts: [...slot.parts] }))
  const rewritten = new Set<number>()
  let current = slots.at(-1)
  let used = current ? slotCost(current) : 0
  const open = (): AgentContextCacheSlot => {
    const slot: AgentContextCacheSlot = { version: 1, captureId, slot: slots.length, parts: [] }
    slots.push(slot)
    used = 0
    return slot
  }
  for (const blob of blobs) {
    let offset = 0
    do {
      if (current === undefined || payload - used < minimum) current = open()
      const room = payload - used - AGENT_CONTEXT_CACHE_PART_OVERHEAD
      const take = Math.min(blob.bytes.byteLength - offset, Math.floor(room / 4) * 3)
      const part = {
        oid: blob.oid,
        offset,
        base64: Buffer.from(blob.bytes.subarray(offset, offset + take)).toString('base64'),
      }
      current.parts.push(part)
      used += partCost(part)
      rewritten.add(current.slot)
      offset += take
    } while (offset < blob.bytes.byteLength)
  }
  return { slots, rewritten: [...rewritten].sort((a, b) => a - b) }
}

/** Reassemble the blobs whose parts in `slots` cover them exactly, verified
 * by `verify` (the git blob oid check). Partial or corrupt blobs are dropped. */
export function unpackContinuation(
  slots: readonly AgentContextCacheSlot[],
  verify: (oid: string, bytes: Uint8Array) => boolean,
): Map<string, Uint8Array> {
  const parts = new Map<string, AgentContextCachePart[]>()
  for (const slot of slots)
    for (const part of slot.parts) {
      const list = parts.get(part.oid) ?? []
      list.push(part)
      parts.set(part.oid, list)
    }
  const blobs = new Map<string, Uint8Array>()
  for (const [oid, list] of parts) {
    list.sort((a, b) => a.offset - b.offset)
    const chunks: Buffer[] = []
    let offset = 0
    let contiguous = true
    for (const part of list) {
      if (part.offset !== offset) {
        contiguous = false
        break
      }
      const chunk = Buffer.from(part.base64, 'base64')
      chunks.push(chunk)
      offset += chunk.byteLength
    }
    if (!contiguous) continue
    const bytes = new Uint8Array(Buffer.concat(chunks))
    if (verify(oid, bytes)) blobs.set(oid, bytes)
  }
  return blobs
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function largestList(largest: readonly { path: string; bytes: number }[]): string {
  return largest.map((entry) => `${entry.path} (${kib(entry.bytes)})`).join(', ')
}

export function formatAgentContextDiagnostic(diagnostic: AgentContextDiagnostic): string {
  const at = (commit?: string) => (commit ? ` at ${commit.slice(0, 12)}` : '')
  switch (diagnostic.kind) {
    case 'oversize':
      return (
        `agent context${at(diagnostic.commit)} encodes to ${kib(diagnostic.bytes)}, over the ` +
        `${kib(diagnostic.bound)} record bound; keeping the last good revision. Largest: ` +
        largestList(diagnostic.largest)
      )
    case 'raw-oversize':
      return (
        `agent context${at(diagnostic.commit)} captures ${kib(diagnostic.rawBytes)} of files, over ` +
        `the ${kib(diagnostic.rawBound)} raw input bound; keeping the last good revision. Largest: ` +
        largestList(diagnostic.largest)
      )
    case 'tree-unlistable':
      return (
        `agent context${at(diagnostic.commit)} not captured: the forge cannot list directory ` +
        `${diagnostic.directory === '' ? '/' : diagnostic.directory} completely; keeping the last good revision`
      )
    case 'capture-failed':
      return `agent context capture${at(diagnostic.commit)} failed: ${diagnostic.message}`
    case 'unavailable':
      return `agent context capture unavailable: ${diagnostic.message}`
  }
}
