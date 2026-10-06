/**
 * Ticket assets (SPEC §7.1): named, versioned bundles of files attached to a
 * ticket and kept in the BuildStore, keyed by `(repo, ticketId, kind, name)`.
 * The ticket source never stores the contents; it only gets a note through
 * `TicketSource.comment()` (SPEC §13).
 *
 * This module is the shared, adapter-independent half: the types, the limits,
 * and the one validator every adapter calls before any write.
 */

import type { AbEvent } from '../events/catalog'
import type { PinnedAsset } from '../events/payloads'
import { defineReducer } from '../kernel/incremental'
import { contentHash, type BlobStore, type BuildStore } from './types'

export type { PinnedAsset }

/** Total file bytes per revision (25 MiB). */
export const TICKET_ASSET_MAX_BYTES = 25 * 1024 * 1024
/** Files plus directories per revision. */
export const TICKET_ASSET_MAX_ENTRIES = 1000
/** UTF-8 bytes per entry path. */
export const TICKET_ASSET_MAX_PATH_BYTES = 256
/** UTF-8 bytes per path segment. */
export const TICKET_ASSET_MAX_SEGMENT_BYTES = 128
/** Kind and name length. */
export const TICKET_ASSET_MAX_LABEL_LENGTH = 64

/** Worst-case JSON envelope around the entries of one put request. */
export const WIRE_ENVELOPE_BYTES = 1024
/** Worst-case JSON per entry besides base64 content: a maximum-length path
 * plus keys, quotes, commas, the type tag, and base64 padding. */
export const WIRE_ENTRY_BYTES = TICKET_ASSET_MAX_PATH_BYTES + 64

export type TicketAssetLayout = 'file' | 'tree'

/** An entry is a file or an explicit directory. Paths are relative and
 * '/'-separated (`index.html`, `img/a.png`, `img/empty`). */
export type TicketAssetEntryInput =
  | { type: 'file'; path: string; content: Uint8Array }
  | { type: 'dir'; path: string }

export interface TicketAssetInput {
  kind: string
  name: string
  layout: TicketAssetLayout
  entries: TicketAssetEntryInput[]
}

export type TicketAssetEntry =
  | { type: 'file'; path: string; size: number; blobRef: string }
  | { type: 'dir'; path: string }

export interface TicketAssetMeta {
  repo: string
  ticketId: string
  kind: string
  name: string
  /** 0-based per `(repo, ticketId, kind, name)`. A removal consumes a number
   * too (a tombstone), so revisions may skip. */
  revision: number
  layout: TicketAssetLayout
  /** Total file bytes. */
  size: number
  entries: TicketAssetEntry[]
  createdAt: string
}

/** What `listTicketAssets` returns on every adapter: the metadata without
 * the manifest. */
export interface TicketAssetSummary {
  repo: string
  ticketId: string
  kind: string
  name: string
  revision: number
  layout: TicketAssetLayout
  size: number
  fileCount: number
  dirCount: number
  createdAt: string
}

export type TicketAssetContentEntry =
  | { type: 'file'; path: string; content: Uint8Array }
  | { type: 'dir'; path: string }

export interface TicketAsset {
  meta: TicketAssetMeta
  entries: TicketAssetContentEntry[]
}

export interface TicketAssetLimits {
  maxBytes: number
  maxEntries: number
}

export const DEFAULT_TICKET_ASSET_LIMITS: TicketAssetLimits = {
  maxBytes: TICKET_ASSET_MAX_BYTES,
  maxEntries: TICKET_ASSET_MAX_ENTRIES,
}

export class TicketAssetValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TicketAssetValidationError'
  }
}

export function summarizeTicketAsset(meta: TicketAssetMeta): TicketAssetSummary {
  let fileCount = 0
  let dirCount = 0
  for (const entry of meta.entries) {
    if (entry.type === 'file') fileCount += 1
    else dirCount += 1
  }
  return {
    repo: meta.repo,
    ticketId: meta.ticketId,
    kind: meta.kind,
    name: meta.name,
    revision: meta.revision,
    layout: meta.layout,
    size: meta.size,
    fileCount,
    dirCount,
    createdAt: meta.createdAt,
  }
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024)
  if (bytes >= 1024 * 1024 && Number.isInteger(mib)) return `${mib} MiB`
  if (bytes >= 1024 * 1024) return `${mib.toFixed(1)} MiB`
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`
  return `${bytes} bytes`
}

/** The limit-naming error for an over-size revision. `size` is the total file
 * bytes the caller tried to store. */
export function ticketAssetSizeError(size: number, limit: number): TicketAssetValidationError {
  return new TicketAssetValidationError(
    `ticket asset exceeds the ${limit}-byte (${formatBytes(limit)}) limit: ${size} bytes`,
  )
}

export function ticketAssetEntriesError(count: number, limit: number): TicketAssetValidationError {
  return new TicketAssetValidationError(
    `ticket asset exceeds the ${limit}-entry limit: ${count} entries (files plus directories)`,
  )
}

/** The effective limits of a store whose requests and responses can carry at
 * most `maxRequestBytes`. Paths and entry counts are bounded, so the worst-case
 * wire overhead is a constant; base64 inflates content by 4/3. A safe lower
 * bound: the client's exact-size check is the final authority. */
export function effectiveTicketAssetLimits(maxRequestBytes?: number): TicketAssetLimits {
  if (maxRequestBytes === undefined) return { ...DEFAULT_TICKET_ASSET_LIMITS }
  const overhead = WIRE_ENVELOPE_BYTES + TICKET_ASSET_MAX_ENTRIES * WIRE_ENTRY_BYTES
  return {
    maxBytes: Math.min(
      TICKET_ASSET_MAX_BYTES,
      Math.max(0, Math.floor(((maxRequestBytes - overhead) * 3) / 4)),
    ),
    maxEntries: TICKET_ASSET_MAX_ENTRIES,
  }
}

const LABEL_PATTERN = /^[A-Za-z0-9._-]+$/

export function validateTicketAssetLabel(field: 'kind' | 'name', value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TicketAssetValidationError(`ticket asset ${field} is required`)
  }
  if (value.length > TICKET_ASSET_MAX_LABEL_LENGTH) {
    throw new TicketAssetValidationError(
      `ticket asset ${field} must be at most ${TICKET_ASSET_MAX_LABEL_LENGTH} characters`,
    )
  }
  if (!LABEL_PATTERN.test(value) || value === '.' || value === '..') {
    throw new TicketAssetValidationError(
      `ticket asset ${field} "${value}" may contain only letters, digits, '.', '_' and '-'`,
    )
  }
}

const encoder = new TextEncoder()

/** One entry path: relative, '/'-separated, no empty/`.`/`..` segments, no
 * NUL, bounded. */
export function validateTicketAssetPath(path: string): void {
  if (typeof path !== 'string' || path === '') {
    throw new TicketAssetValidationError('ticket asset entry path is required')
  }
  if (path.includes('\0')) {
    throw new TicketAssetValidationError(`ticket asset entry path "${path}" contains a NUL byte`)
  }
  if (path.includes('\\')) {
    throw new TicketAssetValidationError(
      `ticket asset entry path "${path}" must use '/' separators`,
    )
  }
  if (encoder.encode(path).length > TICKET_ASSET_MAX_PATH_BYTES) {
    throw new TicketAssetValidationError(
      `ticket asset entry path exceeds ${TICKET_ASSET_MAX_PATH_BYTES} bytes: "${path.slice(0, 40)}…"`,
    )
  }
  if (path.startsWith('/')) {
    throw new TicketAssetValidationError(`ticket asset entry path "${path}" must be relative`)
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new TicketAssetValidationError(
        `ticket asset entry path "${path}" has an empty, '.' or '..' segment`,
      )
    }
    if (encoder.encode(segment).length > TICKET_ASSET_MAX_SEGMENT_BYTES) {
      throw new TicketAssetValidationError(
        `ticket asset entry path segment exceeds ${TICKET_ASSET_MAX_SEGMENT_BYTES} bytes in "${path.slice(0, 40)}…"`,
      )
    }
  }
}

/** Shape and structure of a manifest, independent of content: shared by put
 * validation and the remote server's check of an incoming request. Returns
 * the total file bytes. */
export function validateTicketAssetStructure(
  input: {
    kind: string
    name: string
    layout: TicketAssetLayout
    entries: ({ type: 'file'; path: string; size: number } | { type: 'dir'; path: string })[]
  },
  limits: TicketAssetLimits = DEFAULT_TICKET_ASSET_LIMITS,
): number {
  validateTicketAssetLabel('kind', input.kind)
  validateTicketAssetLabel('name', input.name)
  if (input.layout !== 'file' && input.layout !== 'tree') {
    throw new TicketAssetValidationError(`ticket asset layout must be 'file' or 'tree'`)
  }
  const files = input.entries.filter((entry) => entry.type === 'file')
  if (input.layout === 'file') {
    if (input.entries.length !== 1 || files.length !== 1) {
      throw new TicketAssetValidationError(
        `a 'file' ticket asset has exactly one file entry and no directories`,
      )
    }
    if (files[0]?.path.includes('/')) {
      throw new TicketAssetValidationError(`a 'file' ticket asset's path is its filename`)
    }
  }
  if (input.entries.length > limits.maxEntries) {
    throw ticketAssetEntriesError(input.entries.length, limits.maxEntries)
  }
  const kinds = new Map<string, 'file' | 'dir'>()
  let size = 0
  for (const entry of input.entries) {
    if (entry.type !== 'file' && entry.type !== 'dir') {
      throw new TicketAssetValidationError(`ticket asset entry type must be 'file' or 'dir'`)
    }
    validateTicketAssetPath(entry.path)
    if (kinds.has(entry.path)) {
      throw new TicketAssetValidationError(`duplicate ticket asset entry path "${entry.path}"`)
    }
    kinds.set(entry.path, entry.type)
    if (entry.type === 'file') size += entry.size
  }
  for (const [path] of kinds) {
    const segments = path.split('/')
    for (let end = 1; end < segments.length; end += 1) {
      const ancestor = segments.slice(0, end).join('/')
      if (kinds.get(ancestor) === 'file') {
        throw new TicketAssetValidationError(
          `ticket asset entry "${path}" has a file as its ancestor directory "${ancestor}"`,
        )
      }
    }
  }
  if (size > limits.maxBytes) throw ticketAssetSizeError(size, limits.maxBytes)
  return size
}

/** The one validator every adapter calls before any write. Throws
 * `TicketAssetValidationError`; returns the total file bytes. */
export function validateTicketAssetInput(
  input: TicketAssetInput,
  limits: TicketAssetLimits = DEFAULT_TICKET_ASSET_LIMITS,
): number {
  return validateTicketAssetStructure(
    {
      kind: input.kind,
      name: input.name,
      layout: input.layout,
      entries: input.entries.map((entry) =>
        entry.type === 'file'
          ? { type: 'file', path: entry.path, size: entry.content.byteLength }
          : { type: 'dir', path: entry.path },
      ),
    },
    limits,
  )
}

/** Write each file's bytes to the blob store (content-addressed) and build the
 * manifest. Call only after `validateTicketAssetInput`. */
export async function storeTicketAssetBlobs(
  blobs: BlobStore,
  entries: TicketAssetEntryInput[],
): Promise<TicketAssetEntry[]> {
  const manifest: TicketAssetEntry[] = []
  for (const entry of entries) {
    if (entry.type === 'dir') {
      manifest.push({ type: 'dir', path: entry.path })
      continue
    }
    const blobRef = contentHash(entry.content)
    await blobs.put(blobRef, entry.content)
    manifest.push({ type: 'file', path: entry.path, size: entry.content.byteLength, blobRef })
  }
  return manifest
}

/** Read the bytes of one manifest file; a missing blob is store corruption. */
export async function readTicketAssetBlob(
  blobs: BlobStore,
  meta: TicketAssetMeta,
  entry: { path: string; blobRef: string },
): Promise<Uint8Array> {
  const bytes = await blobs.get(entry.blobRef)
  if (!bytes) {
    throw new Error(
      `ticket asset ${meta.kind}/${meta.name} revision ${meta.revision}: blob for "${entry.path}" is missing`,
    )
  }
  return bytes
}

/** Load a manifest's full content (every adapter's `getTicketAsset` tail). */
export async function loadTicketAsset(
  blobs: BlobStore,
  meta: TicketAssetMeta,
): Promise<TicketAsset> {
  const entries: TicketAssetContentEntry[] = []
  for (const entry of meta.entries) {
    entries.push(
      entry.type === 'dir'
        ? { type: 'dir', path: entry.path }
        : {
            type: 'file',
            path: entry.path,
            content: await readTicketAssetBlob(blobs, meta, entry),
          },
    )
  }
  return { meta: structuredClone(meta), entries }
}

/** What a build pins of one asset revision: the summary minus the ticket
 * coordinates and timestamp, which the build record already carries. */
export function pinnedAssetOf(summary: TicketAssetSummary): PinnedAsset {
  return {
    kind: summary.kind,
    name: summary.name,
    revision: summary.revision,
    layout: summary.layout,
    size: summary.size,
    fileCount: summary.fileCount,
    dirCount: summary.dirCount,
  }
}

/** The set of ticket assets to freeze for a claim or a spec re-pin: every
 * current (live) asset of the ticket, in `listTicketAssets` order. */
export async function samplePinnedAssets(
  store: Pick<BuildStore, 'listTicketAssets'>,
  repo: string,
  ticketId: string,
): Promise<PinnedAsset[]> {
  return (await store.listTicketAssets(repo, ticketId)).map(pinnedAssetOf)
}

export const PINNED_ASSETS_REDUCER_VERSION = 1

/** The asset sets recorded by every `build.created`/`spec.revised` pin event
 * that carries one, in array order. Each pin event replaces the set, so the
 * newest decides the live pin; all of them answer "was this revision ever
 * named". `pinnedRevision` is the query over the finished state. */
export const pinnedAssetsReducer = defineReducer<
  { pins: PinnedAsset[][] },
  AbEvent,
  { pins: PinnedAsset[][] }
>({
  version: PINNED_ASSETS_REDUCER_VERSION,
  initial: () => ({ pins: [] }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type !== 'build.created' && event.type !== 'spec.revised') continue
      const assets = event.payload.assets
      if (assets === undefined) continue
      acc.pins.push(assets)
    }
  },
  finish: (acc) => ({ pins: acc.pins.slice() }),
})

/** Latest-pinned revision of `kind/name` over a reduced pin state, or (with
 * `rev`) the revision when any pin named it. */
export function pinnedRevision(
  state: { pins: readonly (readonly PinnedAsset[])[] },
  kind: string,
  name: string,
  rev?: number,
): number | undefined {
  let latest: number | undefined
  for (const assets of state.pins) {
    if (rev !== undefined) {
      if (assets.some((a) => a.kind === kind && a.name === name && a.revision === rev)) return rev
      continue
    }
    // Each pin event replaces the set, so the newest event that carries a set
    // decides; absent from that set means unpinned.
    latest = assets.find((a) => a.kind === kind && a.name === name)?.revision
  }
  return latest
}

/** Latest-pinned revision of `kind/name` as the build's events record it, or
 * (with `rev`) the revision when any pin in the log named it. */
export function findPinnedRevision(
  events: AbEvent[],
  kind: string,
  name: string,
  rev?: number,
): number | undefined {
  return pinnedRevision(pinnedAssetsReducer.reduce(events), kind, name, rev)
}

/** `BuildStore.getPinnedTicketAsset` for any adapter: read the build's own
 * events to find the pinned revision, then fetch exactly that revision from the
 * ticket's assets. Earlier revisions stay retrievable after a replace or a
 * removal (SPEC §7.1), so the bytes can never drift, and no lease or liveness is
 * needed, so a finished build still answers. Null when the build never pinned
 * `kind/name` (or the revision). Rejects an unknown build. */
export async function resolvePinnedAsset(
  store: Pick<BuildStore, 'getBuild' | 'getEvents' | 'getTicketAsset'>,
  slug: string,
  kind: string,
  name: string,
  rev?: number,
): Promise<TicketAsset | null> {
  const record = await store.getBuild(slug)
  if (record === null) throw new Error(`unknown build "${slug}"`)
  if (record.ticket === undefined) return null
  const revision = findPinnedRevision(await store.getEvents(slug), kind, name, rev)
  if (revision === undefined) return null
  return store.getTicketAsset(record.repo, record.ticket.id, kind, name, revision)
}
