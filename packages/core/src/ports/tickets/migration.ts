import { validateTicketAssetInput } from '../../store/ticket-assets'
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { Ticket, TicketSource, TicketAssetStore } from '../types'
import { projectTicketTree } from './tree'
import { FileTicketSource } from './file'
import { parseTicketFile, serializeTicketFile } from './file-codec'
import { validateFileTicketId } from './requested-id'
import { normalizeStateName } from './states'
import { encodePortableAsset, decodePortableAsset, type PortableAsset } from './portable-assets'

const MANIFEST = '.ab-migration.json'
export const IMPORT_MAP = '.ab-import-map.json'
const manifestSchema = z.strictObject({
  version: z.literal(1),
  identity: z.string().min(1),
  source: z.string(),
  keys: z.record(z.string(), z.string().min(1)),
  states: z.record(z.string(), z.string()),
})
type Manifest = z.infer<typeof manifestSchema>
async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${crypto.randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temp, path)
}
async function inventory(source: TicketSource, signal?: AbortSignal): Promise<Ticket[]> {
  signal?.throwIfAborted()
  const listing = await source.listReady({})
  signal?.throwIfAborted()
  if (listing.diagnostics.length)
    throw new Error(`incomplete ticket scan:\n${listing.diagnostics.join('\n')}`)
  const ids = new Set<string>()
  const tickets: Ticket[] = []
  for (const ticket of listing.tickets) {
    if (ids.has(ticket.ref.id)) throw new Error(`duplicate ticket id: ${ticket.ref.id}`)
    ids.add(ticket.ref.id)
    signal?.throwIfAborted()
    const detail = await source.get(ticket.ref.id)
    signal?.throwIfAborted()
    if (!detail) throw new Error(`ticket disappeared: ${ticket.ref.id}`)
    if (!detail.state) throw new Error(`ticket has no state: ${ticket.ref.id}`)
    tickets.push(detail)
  }
  return tickets
}
function uniqueStateMap(names: string[], map: (name: string) => string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  const groups = new Map<string, string[]>()
  for (const name of new Set(names)) {
    const target = map(name)
    result[name] = target
    groups.set(target, [...(groups.get(target) ?? []), name])
  }
  const collisions = [...groups].filter(([, originals]) => originals.length > 1)
  if (collisions.length)
    throw new Error(
      `state collisions: ${collisions.map(([target, originals]) => `${originals.join(', ')} → ${target}`).join('; ')}`,
    )
  return result
}
async function currentAssets(
  store: TicketAssetStore | undefined,
  repo: string,
  id: string,
  signal?: AbortSignal,
): Promise<PortableAsset[]> {
  signal?.throwIfAborted()
  if (!store) return []
  const result: PortableAsset[] = []
  const summaries = await store.listTicketAssets(repo, id)
  signal?.throwIfAborted()
  for (const summary of summaries) {
    signal?.throwIfAborted()
    const asset = await store.getTicketAsset(repo, id, summary.kind, summary.name, summary.revision)
    signal?.throwIfAborted()
    if (!asset) throw new Error(`asset disappeared: ${id} ${summary.kind}/${summary.name}`)
    result.push(encodePortableAsset({ ...asset.meta, entries: asset.entries }))
  }
  return result
}
export interface MigrationOptions {
  source: TicketSource
  dir: string
  repo: string
  assets?: TicketAssetStore
  signal?: AbortSignal
  print?: (line: string) => void
}
/** Publish a complete portable tracker only after every source read succeeds. */
export async function exportTickets(opts: MigrationOptions): Promise<void> {
  const check = () => opts.signal?.throwIfAborted()
  check()
  const destination = resolve(opts.dir)
  try {
    if ((await readdir(destination)).length)
      throw new Error(`export destination is not empty: ${destination}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  check()
  const tickets = opts.source.readExportSnapshot
    ? await opts.source.readExportSnapshot({
        signal: opts.signal,
        progress: ({ completed, total, resetAt }) => {
          opts.print?.(
            `read ${completed}/${total ?? 'pending'} tickets${resetAt === undefined ? '' : `; waiting until ${new Date(resetAt).toISOString()}`}`,
          )
        },
      })
    : await inventory(opts.source, opts.signal)
  check()
  const ids = new Set<string>()
  for (const ticket of tickets) {
    if (ids.has(ticket.ref.id)) throw new Error(`duplicate ticket id: ${ticket.ref.id}`)
    ids.add(ticket.ref.id)
    if (!ticket.state) throw new Error(`ticket has no state: ${ticket.ref.id}`)
  }
  const names = [
    ...tickets.map((ticket) => ticket.state!),
    ...((await opts.source.listStates?.()) ?? []).map((state) => state.name),
  ]
  check()
  const states = uniqueStateMap(names, normalizeStateName)
  const identity = crypto.randomUUID()
  const manifest: Manifest = {
    version: 1,
    identity,
    source: `${opts.source.name}:${opts.repo}`,
    keys: Object.create(null),
    states,
  }
  const records = []
  for (const ticket of tickets) {
    check()
    validateFileTicketId(ticket.ref.id)
    const key = ticket.creationKey ?? `migration:${identity}:${ticket.ref.id}`
    manifest.keys[ticket.ref.id] = key
    records.push({
      state: states[ticket.state!]!,
      id: ticket.ref.id,
      raw: serializeTicketFile(
        {
          id: ticket.ref.id,
          kind: ticket.kind,
          target: ticket.target,
          title: ticket.title,
          labels: ticket.labels,
          blockedBy: ticket.blockedBy,
          idempotencyKey: key,
          ...(ticket.comments !== undefined ? { comments: ticket.comments } : {}),
          attachments: await currentAssets(
            opts.assets ?? opts.source.assets,
            opts.repo,
            ticket.ref.id,
            opts.signal,
          ),
        },
        ticket.body,
      ),
    })
  }
  check()
  await mkdir(dirname(destination), { recursive: true })
  const staging = `${destination}.${identity}.tmp`
  await mkdir(staging)
  try {
    for (const state of Object.values(states)) {
      check()
      await mkdir(join(staging, state), { recursive: true })
    }
    for (const record of records) {
      check()
      await writeFile(join(staging, record.state, `${record.id}.md`), record.raw, { flag: 'wx' })
    }
    check()
    await atomicJson(join(staging, MANIFEST), manifest)
    // Recheck immediately before publication; never remove a populated destination.
    try {
      check()
      await rmdir(destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    check()
    await rename(staging, destination)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  opts.print?.(`exported ${tickets.length} tickets to ${destination}`)
}
function matchState(name: string, existing: string[]): string | undefined {
  if (existing.includes(name)) return name
  const matches = existing.filter((value) => value.toLowerCase() === name.toLowerCase())
  if (matches.length > 1) throw new Error(`ambiguous target state ${name}: ${matches.join(', ')}`)
  return matches[0]
}
/** Resume through creation keys, never through content similarity or mapping files. */
export async function importTickets(opts: MigrationOptions): Promise<void> {
  const policy = opts.source.requestedIds
  if (!policy || !opts.source.listStates || !opts.source.addState)
    throw new Error(`ticket source ${opts.source.name} does not support import`)
  const dir = resolve(opts.dir)
  const input = new FileTicketSource({ dir })
  const tickets = await inventory(input)
  projectTicketTree(tickets, 'import')
  if (
    !opts.source.integrationTree &&
    tickets.some((t) => t.kind === 'node' || t.target !== undefined)
  )
    throw new Error('target source cannot preserve kind/target metadata')
  const bundles = new Map<string, PortableAsset[]>()
  for (const ticket of tickets) {
    const path = join(dir, ticket.state!, `${ticket.ref.id}.md`)
    bundles.set(
      ticket.ref.id,
      parseTicketFile(path, await readFile(path, 'utf8')).front.attachments ?? [],
    )
  }
  let manifest: Manifest
  try {
    manifest = manifestSchema.parse(JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    manifest = {
      version: 1,
      identity: crypto.randomUUID(),
      source: 'file',
      keys: Object.create(null),
      states: {},
    }
  }
  const sourceIds = new Set(tickets.map((ticket) => ticket.ref.id))
  const keys = new Set<string>()
  for (const ticket of tickets) {
    for (const blocker of ticket.blockedBy ?? [])
      if (!sourceIds.has(blocker) || blocker === ticket.ref.id)
        throw new Error(`invalid blocker ${ticket.ref.id} → ${blocker}`)
    const key =
      ticket.creationKey ??
      manifest.keys[ticket.ref.id] ??
      `migration:${manifest.identity}:${ticket.ref.id}`
    if (keys.has(key)) throw new Error(`duplicate creation key: ${key}`)
    keys.add(key)
    manifest.keys[ticket.ref.id] = key
  }
  const target = await inventory(opts.source)
  const byKey = new Map<string, Ticket>()
  for (const ticket of target)
    if (ticket.creationKey) {
      if (byKey.has(ticket.creationKey))
        throw new Error(`ambiguous target creation key: ${ticket.creationKey}`)
      byKey.set(ticket.creationKey, ticket)
    }
  const existingStates = (await opts.source.listStates()).map((state) => state.name)
  // Only actual input directories participate; virtual lifecycle defaults are harmless empty states.
  const inputStates: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      !entry.name.startsWith('.') &&
      (entry.isDirectory() ||
        (entry.isSymbolicLink() && (await stat(join(dir, entry.name))).isDirectory()))
    )
      inputStates.push(entry.name)
  }
  const states = uniqueStateMap(
    inputStates,
    (name) =>
      matchState(name, existingStates) ??
      matchState(normalizeStateName(name), existingStates) ??
      normalizeStateName(name),
  )
  const planned = new Map<string, string>()
  const occupied = target.map((ticket) => ticket.ref.id)
  const clashes: string[] = []
  for (const ticket of tickets) {
    const adopted = byKey.get(manifest.keys[ticket.ref.id]!)
    if (adopted) {
      planned.set(ticket.ref.id, adopted.ref.id)
      continue
    }
    const kept = policy.preserve(ticket.ref.id)
    if (kept !== undefined) {
      if (occupied.includes(kept)) clashes.push(`${ticket.ref.id} → ${kept}`)
      planned.set(ticket.ref.id, kept)
      occupied.push(kept)
    }
  }
  if (clashes.length)
    throw new Error(`ticket id clashes (no target changes):\n${clashes.join('\n')}`)
  for (const ticket of tickets)
    if (!planned.has(ticket.ref.id)) {
      const id = policy.allocate(occupied)
      planned.set(ticket.ref.id, id)
      occupied.push(id)
    }
  const assets = opts.assets ?? opts.source.assets
  if ([...bundles.values()].some((value) => value.length) && !assets)
    throw new Error('target has no attachment capability')
  if (assets && [...bundles.values()].some((value) => value.length)) {
    const limits = await assets.ticketAssetLimits(opts.repo)
    for (const values of bundles.values())
      for (const bundle of values) validateTicketAssetInput(decodePortableAsset(bundle), limits)
  }
  for (const ticket of tickets) {
    const adopted = byKey.get(manifest.keys[ticket.ref.id]!)
    if ((ticket.comments?.length ?? 0) > 0 && adopted && adopted.comments === undefined)
      throw new Error(`target cannot read comment history: ${adopted.ref.id}`)
  }
  // Persist identities before the first target write, including for ordinary layouts.
  await atomicJson(join(dir, MANIFEST), manifest)
  const mapping: Record<string, string> = Object.create(null)
  const mappingPath = join(dir, IMPORT_MAP)
  const saveMap = () =>
    atomicJson(mappingPath, { version: 1, identity: manifest.identity, states, tickets: mapping })
  await saveMap()
  try {
    for (const state of new Set(Object.values(states)))
      if (!existingStates.includes(state)) {
        try {
          await opts.source.addState(state)
        } catch (error) {
          const discovered = matchState(
            state,
            (await opts.source.listStates()).map((item) => item.name),
          )
          if (!discovered) throw error
          for (const original of Object.keys(states))
            if (states[original] === state) states[original] = discovered
          await saveMap()
        }
      }
    for (const [from, to] of Object.entries(states)) opts.print?.(`state ${from} → ${to}`)
    for (const ticket of tickets) {
      const key = manifest.keys[ticket.ref.id]!
      const result =
        byKey.get(key) ??
        (await opts.source.create(
          {
            title: ticket.title,
            body: ticket.body,
            labels: ticket.labels,
            ...(opts.source.integrationTree ? { kind: ticket.kind ?? 'work' } : {}),
          },
          {
            state: states[ticket.state!]!,
            idempotencyKey: key,
            requestedId: planned.get(ticket.ref.id)!,
          },
        ))
      mapping[ticket.ref.id] = result.ref.id
      await saveMap()
      opts.print?.(`${ticket.ref.id} → ${result.ref.id}`)
    }
    if (opts.source.integrationTree) {
      for (const ticket of tickets)
        if (ticket.kind === 'node')
          await opts.source.update(mapping[ticket.ref.id]!, { kind: 'node' })
      for (const ticket of tickets)
        await opts.source.update(mapping[ticket.ref.id]!, {
          kind: ticket.kind ?? 'work',
          target: ticket.target === undefined ? null : mapping[ticket.target]!,
        })
    }
    for (const ticket of tickets) {
      const id = mapping[ticket.ref.id]!
      for (const blocker of ticket.blockedBy ?? [])
        await opts.source.addBlocker(id, mapping[blocker]!)
      const fresh = await opts.source.get(id)
      if (!fresh) throw new Error(`target disappeared: ${id}`)
      if ((ticket.comments?.length ?? 0) && fresh.comments === undefined)
        throw new Error(`target cannot read comment history: ${id}`)
      const bodies = new Set(fresh.comments?.map((comment) => comment.body))
      for (const comment of ticket.comments ?? [])
        if (!bodies.has(comment.body)) {
          await opts.source.comment(id, comment.body)
          bodies.add(comment.body)
        }
      for (const bundle of bundles.get(ticket.ref.id) ?? []) {
        const current = await assets!.getTicketAsset(opts.repo, id, bundle.kind, bundle.name)
        const canonical = (asset: PortableAsset) =>
          JSON.stringify({
            ...asset,
            entries: [...asset.entries].sort((a, b) => a.path.localeCompare(b.path)),
          })
        if (
          !current ||
          canonical(encodePortableAsset({ ...current.meta, entries: current.entries })) !==
            canonical(bundle)
        )
          await assets!.putTicketAsset(opts.repo, id, decodePortableAsset(bundle))
      }
    }
    opts.print?.(`mapping: ${mappingPath}`)
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : error}\nImport progress retained in ${mappingPath}; rerun import to finish.`,
    )
  }
}
