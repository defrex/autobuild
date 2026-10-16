import { randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { z } from 'zod'
import type { TicketAssetStore } from '../ports/types'
import type { PinnedAsset } from '../events/payloads'
import { contentHash, type BuildStore } from './types'
import {
  pinnedAssetOf,
  summarizeTicketAsset,
  validateTicketAssetInput,
  validateTicketAssetStructure,
  type TicketAsset,
} from './ticket-assets'

const CHUNK_BYTES = 256 * 1024
const refSchema = z.strictObject({
  kind: z.string().regex(/^ticket-snapshot-[a-f0-9-]+$/),
  revision: z.number().int().nonnegative(),
})
const manifestSchema = z.strictObject({
  version: z.literal(1),
  meta: z.strictObject({
    repo: z.string(),
    ticketId: z.string(),
    kind: z.string(),
    name: z.string(),
    revision: z.number().int().nonnegative(),
    layout: z.enum(['file', 'tree']),
    size: z.number().int().nonnegative(),
    createdAt: z.string(),
    entries: z.array(
      z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('dir'), path: z.string() }),
        z.strictObject({
          type: z.literal('file'),
          path: z.string(),
          size: z.number().int().nonnegative(),
          blobRef: z.string(),
        }),
      ]),
    ),
  }),
  files: z.array(
    z.strictObject({
      path: z.string(),
      chunks: z.array(
        refSchema.extend({ hash: z.string(), size: z.number().int().min(1).max(CHUNK_BYTES) }),
      ),
    }),
  ),
})

function verifyMetadata(
  meta: TicketAsset['meta'],
  repo: string,
  ticketId: string,
  pin: PinnedAsset,
): void {
  const summary = pinnedAssetOf(summarizeTicketAsset(meta))
  if (
    meta.repo !== repo ||
    meta.ticketId !== ticketId ||
    Object.entries(summary).some(([key, value]) => pin[key as keyof typeof summary] !== value) ||
    validateTicketAssetStructure(meta) !== meta.size
  )
    throw new Error('inconsistent ticket asset snapshot metadata')
}

function verify(asset: TicketAsset, repo: string, ticketId: string, pin: PinnedAsset): void {
  const { meta, entries } = asset
  verifyMetadata(meta, repo, ticketId, pin)
  if (
    validateTicketAssetInput({ ...meta, entries }) !== meta.size ||
    entries.length !== meta.entries.length
  ) {
    throw new Error('inconsistent ticket asset snapshot metadata')
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const stored = meta.entries[i]!
    if (
      entry.path !== stored.path ||
      entry.type !== stored.type ||
      (entry.type === 'file' &&
        stored.type === 'file' &&
        (entry.content.length !== stored.size || contentHash(entry.content) !== stored.blobRef))
    ) {
      throw new Error('inconsistent ticket asset snapshot content')
    }
  }
}

/** Copy exact sampled revisions before publishing any pins. No current ticket rows
 * are written to the destination; their revision sequences remain independent. */
export async function prepareAssetSnapshots(
  source: Pick<TicketAssetStore, 'listTicketAssets' | 'getTicketAsset'>,
  store: Pick<BuildStore, 'putRepoArtifact' | 'ensureRepo'>,
  repo: string,
  ticketId: string,
  canonicalTicketId: string = ticketId,
): Promise<PinnedAsset[]> {
  const pins = (await source.listTicketAssets(repo, ticketId)).map(pinnedAssetOf)
  if (pins.length > 0) await store.ensureRepo(repo)
  for (const pin of pins) {
    const asset = await source.getTicketAsset(repo, ticketId, pin.kind, pin.name, pin.revision)
    if (!asset) throw new Error('sampled ticket asset revision is missing')
    manifestSchema.shape.meta.parse(asset.meta)
    verify(asset, repo, canonicalTicketId, pin)
    const files = []
    for (const entry of asset.entries) {
      if (entry.type !== 'file') continue
      const chunks = []
      for (let start = 0; start < entry.content.length; start += CHUNK_BYTES) {
        const bytes = entry.content.slice(start, start + CHUNK_BYTES)
        const meta = await store.putRepoArtifact(repo, {
          kind: `ticket-snapshot-${randomUUID()}`,
          content: bytes,
        })
        chunks.push({
          kind: meta.kind,
          revision: meta.revision,
          size: bytes.length,
          hash: contentHash(bytes),
        })
      }
      files.push({ path: entry.path, chunks })
    }
    const meta = await store.putRepoArtifact(repo, {
      kind: `ticket-snapshot-${randomUUID()}`,
      // Compression also bounds manifests with many maximum-length escaped paths.
      content: gzipSync(JSON.stringify({ version: 1, meta: { ...asset.meta, ticketId }, files })),
    })
    pin.snapshot = { kind: meta.kind, revision: meta.revision }
  }
  return pins
}

export async function readAssetSnapshot(
  store: Pick<BuildStore, 'getRepoArtifact'>,
  repo: string,
  ticketId: string,
  pin: PinnedAsset,
  historicalTicketId?: string,
): Promise<TicketAsset> {
  if (!pin.snapshot) throw new Error('missing snapshot reference')
  const artifact = await store.getRepoArtifact(repo, pin.snapshot.kind, pin.snapshot.revision)
  if (!artifact) throw new Error('ticket asset snapshot manifest is missing')
  const manifest = manifestSchema.parse(
    JSON.parse(gunzipSync(artifact.content, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8')),
  )
  // BuildStore projections can display a readable ID while the immutable
  // build.created event and its older snapshots retain the storage alias.
  const snapshotTicketId =
    manifest.meta.ticketId === historicalTicketId ? historicalTicketId : ticketId
  verifyMetadata(manifest.meta, repo, snapshotTicketId, pin)
  const entries: TicketAsset['entries'] = []
  const files = new Map(manifest.files.map((file) => [file.path, file]))
  if (
    files.size !== manifest.files.length ||
    files.size !== manifest.meta.entries.filter((entry) => entry.type === 'file').length
  ) {
    throw new Error('inconsistent ticket asset snapshot files')
  }
  for (const entry of manifest.meta.entries) {
    if (entry.type === 'dir') {
      entries.push(entry)
      continue
    }
    const file = files.get(entry.path)
    if (!file || file.chunks.reduce((size, chunk) => size + chunk.size, 0) !== entry.size) {
      throw new Error('inconsistent ticket asset snapshot chunks')
    }
    const content = new Uint8Array(entry.size)
    let offset = 0
    for (const chunk of file.chunks) {
      const artifact = await store.getRepoArtifact(repo, chunk.kind, chunk.revision)
      if (
        !artifact ||
        artifact.content.length !== chunk.size ||
        contentHash(artifact.content) !== chunk.hash
      ) {
        throw new Error('ticket asset snapshot chunk is missing or corrupt')
      }
      content.set(artifact.content, offset)
      offset += chunk.size
    }
    entries.push({ type: 'file', path: entry.path, content })
  }
  const asset = { meta: manifest.meta, entries }
  verify(asset, repo, snapshotTicketId, pin)
  return asset
}
