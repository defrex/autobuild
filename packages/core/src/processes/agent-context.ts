/**
 * The dispatcher's agent-context stage: keep one repository-level record of
 * the base branch's installed skills and agent instructions in the store
 * (`store/agent-context.ts`), read through the forge in both checkout and
 * origin mode so both produce the same record for the same commit.
 *
 * Recurring cost: one base-head read per minute per process (and on its
 * first tick), and one ~1 KiB pointer read per process. While the head is unchanged nothing else is read. A head
 * change reads the tree; a change to the context fingerprint additionally
 * reads the latest record (to reuse its blobs) and fetches only new blobs.
 * No repository events are read or written.
 */
import { randomUUID } from 'node:crypto'
import { rethrowAuthorityLapse } from '../cli/repo-lease'
import { ForgeTreeUnlistable } from '../ports/forge-failure'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import { gitBlobOid, matchesGitBlobOid } from '../ports/forge/git-blob'
import type { Forge, ForgeTreeEntry } from '../ports/types'
import {
  AGENT_CONTEXT_ARTIFACT,
  AGENT_CONTEXT_CACHE_SLOT_PAYLOAD,
  AGENT_CONTEXT_CACHE_SLOTS,
  AGENT_CONTEXT_HEAD_ARTIFACT,
  AGENT_CONTEXT_MAX_BYTES,
  AGENT_CONTEXT_MAX_RAW_BYTES,
  agentContextCacheKind,
  contentBytes,
  decodeAgentContext,
  decodeAgentContextCache,
  decodeAgentContextPointer,
  encodeAgentContext,
  encodeAgentContextCache,
  encodeAgentContextPointer,
  packContinuation,
  unpackContinuation,
  type AgentContextCacheSlot,
  type AgentContextDiagnostic,
  type AgentContextPointer,
  type AgentContextRecord,
} from '../store/agent-context'
import type { BuildStore } from '../store/types'
import {
  assembleAgentContext,
  contextKey,
  type AgentContextContributor,
} from './agent-context-assemble'

/** Blob reads in flight at once. */
const FETCH_CONCURRENCY = 8
/** Time kept back from the invocation deadline for the continuation write. */
const DEADLINE_RESERVE_MS = 2_000
const LARGEST = 5
/** A failed capture is retried at the same head after this long, and at
 * once when the head moves, so a persistent failure costs no per-tick reads. */
export const AGENT_CONTEXT_RETRY_MS = 5 * 60_000
/** A process reads the base head at most this often (always on its first
 * run), so idle ticks make no forge request, and no guarded-forge health
 * read, for the context. */
export const AGENT_CONTEXT_HEAD_POLL_MS = 60_000

export interface AgentContextBounds {
  maxBytes: number
  maxRawBytes: number
  slotPayload: number
  slots: number
}

export interface AgentContextRunOpts {
  baseBranch: string
  /** Invocation bound in epoch ms against `now`. */
  deadlineAt?: number
  /** Repository authority; when false the stage reads and writes nothing. */
  holdsAuthority?: () => boolean
}

type Store = Pick<BuildStore, 'getRepoArtifact' | 'putRepoArtifact'>

interface Continuation {
  captureId: string
  slots: AgentContextCacheSlot[]
  /** Every pointer-named slot was present and carried this capture's id. */
  intact: boolean
  blobs: Map<string, Uint8Array>
}

function seedFromRecord(cache: Map<string, Uint8Array>, record: AgentContextRecord): void {
  for (const skill of record.skills)
    for (const file of skill.files) cache.set(file.oid, contentBytes(file))
  for (const entry of record.instructions) cache.set(entry.oid, contentBytes(entry))
  for (const entry of record.imports) cache.set(entry.oid, contentBytes(entry))
  for (const link of record.links) {
    const bytes = new TextEncoder().encode(link.target)
    cache.set(gitBlobOid(bytes), bytes)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AgentContextCapture {
  private readonly store: Store
  private readonly repo: string
  private readonly forge: Forge
  /** The dispatch clock, read only to honor `deadlineAt`. */
  private readonly now: () => number
  /** Monotonic process time pacing head polls and failure retries. */
  private readonly elapsed: () => number
  private readonly bounds: AgentContextBounds
  /** Last pointer this process read or wrote; `null` when none exists. This
   * dispatcher is the pointer's only writer while it holds the repository. */
  private pointer: AgentContextPointer | null | undefined
  private unavailableReported = false
  private lastFailure: { message: string; head?: string; at: number } | undefined
  private headReadAt: number | undefined

  constructor(opts: {
    store: Store
    repo: string
    forge: Forge
    now?: () => number
    /** Pacing clock in ms; defaults to monotonic process time. */
    elapsed?: () => number
    bounds?: Partial<AgentContextBounds>
  }) {
    this.store = opts.store
    this.repo = opts.repo
    this.forge = opts.forge
    this.now = opts.now ?? (() => Date.now())
    this.elapsed = opts.elapsed ?? (() => performance.now())
    this.bounds = {
      maxBytes: opts.bounds?.maxBytes ?? AGENT_CONTEXT_MAX_BYTES,
      maxRawBytes: opts.bounds?.maxRawBytes ?? AGENT_CONTEXT_MAX_RAW_BYTES,
      slotPayload: opts.bounds?.slotPayload ?? AGENT_CONTEXT_CACHE_SLOT_PAYLOAD,
      slots: opts.bounds?.slots ?? AGENT_CONTEXT_CACHE_SLOTS,
    }
  }

  async run(opts: AgentContextRunOpts): Promise<AgentContextDiagnostic[]> {
    if (opts.holdsAuthority?.() === false) return []
    const forge = this.forge
    if (!forge.remoteBranchSha || !forge.readTree || !forge.readBlob) {
      if (this.unavailableReported) return []
      this.unavailableReported = true
      return [
        {
          kind: 'unavailable',
          message: `the ${forge.name} forge cannot read repository trees and blobs`,
        },
      ]
    }
    if (
      this.headReadAt !== undefined &&
      this.elapsed() - this.headReadAt < AGENT_CONTEXT_HEAD_POLL_MS
    )
      return []
    this.headReadAt = this.elapsed()
    let head: string | undefined
    try {
      head = await forge.remoteBranchSha(opts.baseBranch)
      const failed = this.lastFailure
      if (failed?.head === head && this.elapsed() - failed.at < AGENT_CONTEXT_RETRY_MS) return []
      const diagnostics = await this.capture(head, opts)
      this.lastFailure = undefined
      return diagnostics
    } catch (error) {
      rethrowAuthorityLapse(error)
      if (error instanceof ForgeRequestDeferred) return []
      const text = message(error)
      const repeated = this.lastFailure?.message === text
      this.lastFailure = {
        message: text,
        ...(head !== undefined ? { head } : {}),
        at: this.elapsed(),
      }
      // Reported once per distinct failure.
      if (repeated) return []
      return [
        { kind: 'capture-failed', ...(head !== undefined ? { commit: head } : {}), message: text },
      ]
    }
  }

  private async loadPointer(): Promise<AgentContextPointer | null> {
    if (this.pointer !== undefined) return this.pointer
    const artifact = await this.store.getRepoArtifact(this.repo, AGENT_CONTEXT_HEAD_ARTIFACT)
    let pointer: AgentContextPointer | null = null
    if (artifact) {
      try {
        pointer = decodeAgentContextPointer(artifact.content)
      } catch {
        // An unreadable pointer only costs a recapture.
        pointer = null
      }
    }
    this.pointer = pointer
    return pointer
  }

  private async writePointer(pointer: AgentContextPointer): Promise<void> {
    this.pointer = undefined
    await this.store.putRepoArtifact(this.repo, {
      kind: AGENT_CONTEXT_HEAD_ARTIFACT,
      content: encodeAgentContextPointer(pointer),
    })
    this.pointer = pointer
  }

  private async capture(
    head: string,
    opts: AgentContextRunOpts,
  ): Promise<AgentContextDiagnostic[]> {
    const forge = this.forge as Required<Pick<Forge, 'readTree' | 'readBlob'>> & Forge
    const lost = () => opts.holdsAuthority?.() === false
    const branch = opts.baseBranch
    const loaded = await this.loadPointer()
    const pointer = loaded !== null && loaded.branch === branch ? loaded : null
    if (pointer?.observed === head && pointer.pending === undefined) return []
    const settled: AgentContextPointer = {
      version: 1,
      branch,
      observed: pointer?.observed ?? null,
      key: pointer?.key ?? null,
      dependencies: pointer?.dependencies ?? [],
      ...(pointer?.revision !== undefined ? { revision: pointer.revision } : {}),
      ...(pointer?.digest !== undefined ? { digest: pointer.digest } : {}),
      ...(pointer?.diagnostic !== undefined ? { diagnostic: pointer.diagnostic } : {}),
    }

    let entries: ForgeTreeEntry[]
    try {
      entries = await forge.readTree(head)
    } catch (error) {
      if (!(error instanceof ForgeTreeUnlistable)) throw error
      const diagnostic: AgentContextDiagnostic = {
        kind: 'tree-unlistable',
        commit: head,
        directory: error.directory,
      }
      if (!lost()) await this.writePointer({ ...settled, observed: head, diagnostic })
      return [diagnostic]
    }

    // An unchanged fingerprint means an unchanged record: no blob or record reads.
    if (pointer?.key != null && contextKey(entries, pointer.dependencies) === pointer.key) {
      if (!lost()) await this.writePointer({ ...settled, observed: head })
      return []
    }

    const cache = new Map<string, Uint8Array>()
    const latest = await this.store.getRepoArtifact(this.repo, AGENT_CONTEXT_ARTIFACT)
    const latestDigest =
      typeof latest?.meta.metadata.digest === 'string' ? latest.meta.metadata.digest : undefined
    const latestRevision = latest?.meta.revision
    if (latest) {
      try {
        seedFromRecord(cache, decodeAgentContext(latest.content))
      } catch {
        // An unreadable record only costs refetching its blobs.
      }
    }
    const continuation = await this.readContinuation(loaded?.pending)
    for (const [oid, bytes] of continuation?.blobs ?? []) cache.set(oid, bytes)

    const kept = {
      ...(latestRevision !== undefined ? { revision: latestRevision } : {}),
      ...(latestDigest !== undefined ? { digest: latestDigest } : {}),
    }
    const rawOversize = async (
      rawBytes: number,
      contributors: AgentContextContributor[],
      dependencies: string[],
    ): Promise<AgentContextDiagnostic[]> => {
      const diagnostic: AgentContextDiagnostic = {
        kind: 'raw-oversize',
        commit: head,
        rawBound: this.bounds.maxRawBytes,
        rawBytes,
        largest: contributors.slice(0, LARGEST),
      }
      if (!lost())
        await this.writePointer({
          version: 1,
          branch,
          observed: head,
          key: contextKey(entries, dependencies),
          dependencies,
          ...kept,
          diagnostic,
        })
      return [diagnostic]
    }

    const fetched = new Map<string, Uint8Array>()
    for (;;) {
      const pass = assembleAgentContext({
        commit: head,
        baseBranch: branch,
        entries,
        blob: (oid) => cache.get(oid),
      })
      if (pass.rawBytes > this.bounds.maxRawBytes)
        return rawOversize(pass.rawBytes, pass.contributors, pass.dependencies)
      const record = pass.record
      if (record !== undefined) {
        const encoded = encodeAgentContext(record)
        // The reader's decode ceiling is this same bound: never publish a
        // record it would refuse.
        if (encoded.jsonBytes > this.bounds.maxRawBytes)
          return rawOversize(encoded.jsonBytes, pass.contributors, pass.dependencies)
        const key = contextKey(entries, pass.dependencies)
        const bytes = encoded.content.byteLength
        if (bytes > this.bounds.maxBytes) {
          const diagnostic: AgentContextDiagnostic = {
            kind: 'oversize',
            commit: head,
            bound: this.bounds.maxBytes,
            bytes,
            largest: pass.contributors.slice(0, LARGEST),
          }
          if (!lost())
            await this.writePointer({
              version: 1,
              branch,
              observed: head,
              key,
              dependencies: pass.dependencies,
              ...kept,
              diagnostic,
            })
          return [diagnostic]
        }
        if (lost()) return []
        let revision = latestRevision
        if (encoded.digest !== latestDigest) {
          const meta = await this.store.putRepoArtifact(this.repo, {
            kind: AGENT_CONTEXT_ARTIFACT,
            content: encoded.content,
            metadata: {
              schema: 1,
              commit: head,
              digest: encoded.digest,
              bytes,
              rawBytes: encoded.rawBytes,
            },
          })
          revision = meta.revision
        }
        // Written after the record: a crash between the two re-runs assembly,
        // and the digest comparison above keeps that from duplicating it.
        await this.writePointer({
          version: 1,
          branch,
          observed: head,
          key,
          dependencies: pass.dependencies,
          ...(revision !== undefined ? { revision } : {}),
          digest: encoded.digest,
        })
        return []
      }
      for (let i = 0; i < pass.missing.length; i += FETCH_CONCURRENCY) {
        if (opts.deadlineAt !== undefined && opts.deadlineAt - this.now() < DEADLINE_RESERVE_MS) {
          if (!lost())
            await this.persistContinuation({
              head,
              settled,
              continuation,
              wanted: pass.wanted,
              fetched,
            })
          return []
        }
        const batch = pass.missing.slice(i, i + FETCH_CONCURRENCY)
        const blobs = await Promise.all(batch.map((oid) => forge.readBlob(oid)))
        batch.forEach((oid, index) => {
          const bytes = blobs[index]!
          cache.set(oid, bytes)
          fetched.set(oid, bytes)
        })
      }
    }
  }

  /** The live continuation the pointer names. A missing or foreign slot is
   * never a failure: only its bytes are lost, and they are fetched again. */
  private async readContinuation(
    pending: AgentContextPointer['pending'],
  ): Promise<Continuation | undefined> {
    if (pending === undefined) return undefined
    const slots: AgentContextCacheSlot[] = []
    let intact = true
    for (let index = 0; index < pending.slots; index++) {
      const artifact = await this.store.getRepoArtifact(this.repo, agentContextCacheKind(index))
      let slot: AgentContextCacheSlot | undefined
      try {
        slot = artifact ? decodeAgentContextCache(artifact.content) : undefined
      } catch {
        slot = undefined
      }
      if (slot === undefined || slot.captureId !== pending.captureId || slot.slot !== index) {
        intact = false
        continue
      }
      slots.push(slot)
    }
    return {
      captureId: pending.captureId,
      slots,
      intact,
      blobs: unpackContinuation(slots, matchesGitBlobOid),
    }
  }

  /** Persist what this invocation fetched, plus the earlier continuation
   * still needed, then point at it. An unchanged selection keeps every full
   * slot and rewrites only the last partial one; otherwise a fresh capture
   * repacks densely from slot 0. */
  private async persistContinuation(input: {
    head: string
    settled: AgentContextPointer
    continuation: Continuation | undefined
    wanted: ReadonlySet<string>
    fetched: ReadonlyMap<string, Uint8Array>
  }): Promise<void> {
    const { continuation, wanted, fetched } = input
    const reuse =
      continuation?.intact === true &&
      continuation.slots.every((slot) => slot.parts.every((part) => wanted.has(part.oid)))
    let captureId: string
    let base: AgentContextCacheSlot[]
    const blobs: { oid: string; bytes: Uint8Array }[] = []
    if (reuse) {
      captureId = continuation.captureId
      base = continuation.slots
    } else {
      captureId = randomUUID()
      base = []
      for (const [oid, bytes] of continuation?.blobs ?? [])
        if (wanted.has(oid) && !fetched.has(oid)) blobs.push({ oid, bytes })
    }
    for (const [oid, bytes] of fetched) blobs.push({ oid, bytes })
    if (blobs.length === 0) return
    const packed = packContinuation(captureId, base, blobs, this.bounds.slotPayload)
    // Past the slot budget, the excess is simply fetched again later.
    const slots = packed.slots.slice(0, this.bounds.slots)
    for (const index of packed.rewritten) {
      const slot = slots[index]
      if (slot === undefined) continue
      await this.store.putRepoArtifact(this.repo, {
        kind: agentContextCacheKind(index),
        content: encodeAgentContextCache(slot),
      })
    }
    await this.writePointer({
      ...input.settled,
      pending: { head: input.head, captureId, slots: slots.length },
    })
  }
}
