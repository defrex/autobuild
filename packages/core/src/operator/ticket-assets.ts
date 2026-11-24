/**
 * Ticket assets for the operator surface (SPEC §7.1, §8.8): the service half
 * of the `tickets.asset.*` tools. Same pieces and order as `ab ticket attach`,
 * `ab ticket asset get` and `ab ticket asset rm`: the source is asked first,
 * so an unknown ticket stores nothing; the shared validator runs before any
 * write; the note follows the store write, so it never points at nothing.
 * Bytes cross the wire as base64.
 */

import { ticketAssetNote } from '../cli/ticket-assets'
import { TicketOperationError, requireTicket } from '../ports/tickets/operations'
import type { TicketSource } from '../ports/types'
import {
  composeTicketAssets,
  validateTicketAssetInput,
  type TicketAssetInput,
  type TicketAssetLayout,
  type TicketAssetMeta,
} from '../store/ticket-assets'
import type { TicketAssetStore } from '../ports/types'
import type { BuildStore } from '../store/types'
import { activeTicketBuilds, assetTicketId } from './ticket-asset-list'
import { openOperatorTickets, type OperatorTicketBackend } from './tickets'

export {
  activeTicketBuilds,
  assetTicketId,
  listOperatorTicketAssets,
  projectTicketAssets,
  type OperatorTicketAsset,
} from './ticket-asset-list'

/** One asset entry on the wire: a file with its exact bytes, or a directory. */
export type OperatorTicketAssetEntry =
  | { type: 'file'; path: string; contentBase64: string }
  | { type: 'dir'; path: string }

interface OperatorTicketAssetTarget {
  store: BuildStore
  repo: string
  backend: OperatorTicketBackend
  id: string
}

async function openTicketAssets(opts: OperatorTicketAssetTarget): Promise<{
  source: TicketSource
  assets: TicketAssetStore
  key: string
  hosted: boolean
}> {
  const { context, source } = await openOperatorTickets(opts)
  if (source.name === 'hosted' && !source.assets)
    throw new TicketOperationError('refusal', 'hosted ticket source has no asset capability')
  return {
    source,
    assets: composeTicketAssets(source, opts.store),
    key: assetTicketId(source.name, opts.id),
    hosted: source.name === 'hosted' || context.tickets.source === 'hosted',
  }
}

/** Leave the note; a failure is reported, never thrown, because the store
 * change already happened and retrying would change it again. */
async function leaveNote(source: TicketSource, id: string, note: string): Promise<string | null> {
  try {
    await source.comment(id, note)
    return null
  } catch (error) {
    return `the note on ${source.name}:${id} failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

export async function attachOperatorTicketAsset(
  opts: OperatorTicketAssetTarget & {
    kind: string
    name: string
    layout: TicketAssetLayout
    entries: OperatorTicketAssetEntry[]
  },
): Promise<{
  asset: TicketAssetMeta
  replaced: boolean
  activeBuilds: string[]
  noteError?: string
}> {
  const { source, assets, key, hosted } = await openTicketAssets(opts)
  await requireTicket(source, key)
  const input: TicketAssetInput = {
    kind: opts.kind,
    name: opts.name,
    layout: opts.layout,
    entries: opts.entries.map((entry) =>
      entry.type === 'file'
        ? {
            type: 'file',
            path: entry.path,
            content: new Uint8Array(Buffer.from(entry.contentBase64, 'base64')),
          }
        : { type: 'dir', path: entry.path },
    ),
  }
  validateTicketAssetInput(input, await assets.ticketAssetLimits(opts.repo))
  const replaced = (await assets.listTicketAssets(opts.repo, key)).some(
    (asset) => asset.kind === input.kind && asset.name === input.name,
  )
  const asset = await assets.putTicketAsset(opts.repo, key, input)
  const activeBuilds = await activeTicketBuilds(opts.store, opts.repo, key)
  const noteError = await leaveNote(
    source,
    key,
    ticketAssetNote(replaced ? 'replaced' : 'attached', asset, 'ab', hosted),
  )
  return { asset, replaced, activeBuilds, ...(noteError !== null ? { noteError } : {}) }
}

export async function getOperatorTicketAsset(
  opts: OperatorTicketAssetTarget & { kind: string; name: string; rev?: number },
): Promise<{
  asset: TicketAssetMeta
  entries: (
    | { type: 'file'; path: string; size: number; contentBase64: string }
    | {
        type: 'dir'
        path: string
      }
  )[]
}> {
  const { assets, key } = await openTicketAssets(opts)
  const found = await assets.getTicketAsset(opts.repo, key, opts.kind, opts.name, opts.rev)
  if (found === null) {
    const revision = opts.rev === undefined ? '' : ` revision ${opts.rev}`
    throw new TicketOperationError(
      'not-found',
      `ticket ${key} has no asset ${opts.kind}/${opts.name}${revision}` +
        (opts.rev === undefined ? ' (it may have been removed — pass rev)' : ''),
    )
  }
  return {
    asset: found.meta,
    entries: found.entries.map((entry) =>
      entry.type === 'file'
        ? {
            type: 'file',
            path: entry.path,
            size: entry.content.byteLength,
            contentBase64: Buffer.from(entry.content).toString('base64'),
          }
        : { type: 'dir', path: entry.path },
    ),
  }
}

export async function removeOperatorTicketAsset(
  opts: OperatorTicketAssetTarget & { kind: string; name: string },
): Promise<{ removed: TicketAssetMeta; activeBuilds: string[]; noteError?: string }> {
  const { source, assets, key, hosted } = await openTicketAssets(opts)
  await requireTicket(source, key)
  const removed = await assets.removeTicketAsset(opts.repo, key, opts.kind, opts.name)
  if (removed === null)
    throw new TicketOperationError(
      'not-found',
      `ticket ${key} has no current asset ${opts.kind}/${opts.name} to remove`,
    )
  const activeBuilds = await activeTicketBuilds(opts.store, opts.repo, key)
  const noteError = await leaveNote(source, key, ticketAssetNote('removed', removed, 'ab', hosted))
  return { removed, activeBuilds, ...(noteError !== null ? { noteError } : {}) }
}
