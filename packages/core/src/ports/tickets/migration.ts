import { validateTicketAssetInput } from '../../store/ticket-assets'
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { TicketRef } from '../../ontology'
import { resolveTicketRef, type TicketMigrations } from '../../kernel/ticket-migrations'
import type { IssueLink, Ticket, TicketSource, TicketAssetStore } from '../types'
import {
  holdsState,
  LIFECYCLE_ROLES,
  type LifecycleRole,
  roleState,
  stateRolesIn,
  type TicketLifecycle,
} from './lifecycle'
import { projectTicketTree } from './tree'
import { FileTicketSource } from './file'
import { parseTicketFile, serializeTicketFile } from './file-codec'
import { validateFileTicketId } from './requested-id'
import { normalizeStateName } from './states'
import { TicketIssueLinksUnsupported } from './issue-links'
import { encodePortableAsset, decodePortableAsset, type PortableAsset } from './portable-assets'

export const MANIFEST = '.ab-migration.json'
export const IMPORT_MAP = '.ab-import-map.json'
const manifestSchema = z.strictObject({
  version: z.literal(1),
  identity: z.string().min(1),
  source: z.string().regex(/^[a-z][a-z0-9-]*(?::[\s\S]*)?$/),
  keys: z.record(z.string(), z.string().min(1)),
  states: z.record(z.string(), z.string()),
  /** State directory → the lifecycle roles its state held in the exporting
   * source. Import lands a role-holding state in the destination's state for
   * the same role, whatever either source calls it. */
  roles: z.record(z.string(), z.array(z.enum(LIFECYCLE_ROLES))).optional(),
  /** When an import first saved this identity and its creation keys; every
   * later keyed create from the input happens after it. Export never writes
   * it, so export bytes stay unchanged. */
  reservedAt: z.string().datetime().optional(),
})
export type Manifest = z.infer<typeof manifestSchema>
export async function readMigrationManifest(dir: string): Promise<Manifest> {
  return manifestSchema.parse(JSON.parse(await readFile(join(resolve(dir), MANIFEST), 'utf8')))
}
export function migrationSource(manifest: Manifest): string {
  // v1 combines adapter name and repository provenance; URLs may contain colons.
  return manifest.source.split(':', 1)[0]!
}
export interface MigrationResult {
  identity: string
  from: string
  to: string
  mapping: Record<string, string>
}
export async function directMigration(opts: MigrationOptions): Promise<MigrationResult> {
  if (opts.source.name !== 'file')
    throw new Error('direct migration recording requires a file destination')
  const manifest = await readMigrationManifest(opts.dir)
  const mapping: Record<string, string> = Object.create(null)
  const exported = new FileTicketSource({ dir: resolve(opts.dir) })
  // The manifest freezes the export inventory; the directory may now be a live
  // tracker with additional tickets. Only the original IDs establish continuity.
  for (const [id, key] of Object.entries(manifest.keys)) {
    validateFileTicketId(id)
    const ticket = await exported.get(id)
    const destination = await opts.source.get(id)
    if (ticket?.creationKey !== key || destination?.creationKey !== key)
      throw new Error(`migration evidence mismatch for ${id}`)
    mapping[id] = id
  }
  return {
    identity: manifest.identity,
    from: migrationSource(manifest),
    to: opts.source.name,
    mapping,
  }
}
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
/** Map state names one to one. Names in `merge` (role-mapped states) may
 * share a target with each other, never with a name-mapped state. */
function uniqueStateMap(
  names: string[],
  map: (name: string) => string,
  merge: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  const groups = new Map<string, string[]>()
  for (const name of new Set(names)) {
    const target = map(name)
    result[name] = target
    groups.set(target, [...(groups.get(target) ?? []), name])
  }
  const collisions = [...groups].filter(
    ([, originals]) => originals.length > 1 && !originals.every((name) => merge.has(name)),
  )
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
  /** The configured source's lifecycle: the source on export (recorded as
   * manifest roles), the destination on import (where those roles land). */
  lifecycle?: TicketLifecycle
  /** Import only tickets in these input states (`--states`). */
  states?: string[]
  /** Unfinished builds' ticket and target refs, consulted only with
   * `states`: a selection may not leave one of their tickets behind. */
  inFlight?: { build: string; ticket: TicketRef }[]
  /** Recorded continuity, to resolve `inFlight` refs into the export. */
  migrations?: TicketMigrations
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
  if (opts.lifecycle) {
    const roles: Record<string, LifecycleRole[]> = Object.create(null)
    for (const [name, directory] of Object.entries(states)) {
      const held = stateRolesIn(opts.lifecycle, name)
      if (held.length) roles[directory] = held
    }
    if (Object.keys(roles).length) manifest.roles = roles
  }
  const records = []
  for (const ticket of tickets) {
    check()
    validateFileTicketId(ticket.ref.id)
    if (ticket.comments === undefined && opts.source.readComments) {
      const comments = await opts.source.readComments(ticket.ref.id)
      check()
      if (comments === null) throw new Error(`ticket disappeared: ${ticket.ref.id}`)
      ticket.comments = comments
    }
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
          issueLinks: ticket.issueLinks,
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
interface Selection {
  tickets: Ticket[]
  /** Input state directories the import creates at the destination. */
  states: string[]
  /** Each selected ticket's blockers, less those left behind as done. */
  blockers: Map<string, string[]>
}
/** Resolve `--states` to input directories and keep their tickets. A blocker
 * on a left-out done ticket is dropped as resolved; every other reference to a
 * left-out ticket, and every unfinished build on one, is a problem. */
function selectTickets(
  opts: MigrationOptions,
  all: Ticket[],
  inputStates: string[],
  manifest: Manifest,
  problems: string[],
): Selection {
  const ids = new Set(all.map((ticket) => ticket.ref.id))
  let chosen = new Set(inputStates)
  if (opts.states) {
    chosen = new Set()
    const originals = Object.entries(manifest.states)
    for (const name of opts.states) {
      const folded = inputStates.filter((state) => state.toLowerCase() === name.toLowerCase())
      const named = [
        ...new Set(
          originals
            .filter(([original]) => original.toLowerCase() === name.toLowerCase())
            .map(([, directory]) => directory)
            .filter((directory) => inputStates.includes(directory)),
        ),
      ]
      const directory =
        inputStates.find((state) => state === name) ??
        (folded.length === 1 ? folded[0] : undefined) ??
        (named.length === 1 ? named[0] : undefined)
      if (directory === undefined)
        problems.push(
          `--states names unknown state "${name}"; the export holds: ${inputStates.join(', ') || 'none'}`,
        )
      else chosen.add(directory)
    }
  }
  const done = (state: string) =>
    manifest.roles
      ? (manifest.roles[state]?.includes('done') ?? false)
      : holdsState(state, opts.lifecycle?.done ?? 'done')
  const stateOf = new Map(all.map((ticket) => [ticket.ref.id, ticket.state!]))
  const excluded = (id: string) => ids.has(id) && !chosen.has(stateOf.get(id)!)
  const tickets = all.filter((ticket) => chosen.has(ticket.state!))
  const blockers = new Map<string, string[]>()
  for (const ticket of tickets) {
    const kept: string[] = []
    for (const blocker of ticket.blockedBy ?? []) {
      if (!ids.has(blocker) || blocker === ticket.ref.id)
        throw new Error(`invalid blocker ${ticket.ref.id} → ${blocker}`)
      if (!excluded(blocker)) kept.push(blocker)
      else if (!done(stateOf.get(blocker)!))
        problems.push(`${ticket.ref.id} is blocked by ${blocker}, which --states excludes`)
    }
    blockers.set(ticket.ref.id, kept)
    if (ticket.target !== undefined && excluded(ticket.target))
      problems.push(`${ticket.ref.id} targets ${ticket.target}, which --states excludes`)
    if (migrationSource(manifest) === 'github')
      for (const link of ticket.issueLinks ?? [])
        if (excluded(String(link.issue)))
          problems.push(`${ticket.ref.id} links issue #${link.issue}, which --states excludes`)
  }
  if (opts.states) {
    const from = migrationSource(manifest)
    for (const { build, ticket } of opts.inFlight ?? []) {
      let ref: TicketRef
      try {
        ref = resolveTicketRef(opts.migrations ?? { migrations: [] }, ticket, from, build)
      } catch {
        // Refs outside this export's namespace do not belong to it.
        continue
      }
      if (excluded(ref.id))
        problems.push(`build ${build} is unfinished for ticket ${ref.id}, which --states excludes`)
    }
  }
  return { tickets, states: inputStates.filter((state) => chosen.has(state)), blockers }
}
/** Land each input state: a role-holding state in the destination's state for
 * its primary role, any other by name. */
function planStates(
  inputStates: string[],
  manifest: Manifest,
  lifecycle: TicketLifecycle | undefined,
  existing: string[],
  problems: string[],
): Record<string, string> {
  const merged = new Set<string>()
  const byRole = (name: string): string | undefined => {
    const held = manifest.roles?.[name]
    if (!lifecycle || !held?.length) return undefined
    const role = LIFECYCLE_ROLES.find((candidate) => held.includes(candidate))!
    const target = roleState(lifecycle, role)
    if (target === undefined) {
      problems.push(
        `state ${name} holds the ${role} role, but the destination has no ${role} state; configure [tickets].${role}State`,
      )
      return undefined
    }
    merged.add(name)
    return matchState(target, existing) ?? target
  }
  return uniqueStateMap(
    inputStates,
    (name) =>
      byRole(name) ??
      matchState(name, existing) ??
      matchState(normalizeStateName(name), existing) ??
      normalizeStateName(name),
    merged,
  )
}
/** Issue links rewritten through the mapping. Only an export from GitHub
 * names this repository's tickets by issue number. */
function mappedIssueLinks(
  links: IssueLink[] | undefined,
  ids: ReadonlySet<string>,
  mapping: Record<string, string>,
): IssueLink[] {
  return (links ?? []).map((link) => {
    const mapped = ids.has(String(link.issue)) ? mapping[String(link.issue)] : undefined
    return mapped !== undefined && /^[1-9][0-9]*$/.test(mapped)
      ? { ...link, issue: Number(mapped) }
      : link
  })
}
/** Resume through creation keys, never through content similarity or mapping files. */
export async function importTickets(opts: MigrationOptions): Promise<MigrationResult> {
  const policy = opts.source.requestedIds
  if ((!policy && !opts.source.allocatesIds) || !opts.source.listStates || !opts.source.addState)
    throw new Error(`ticket source ${opts.source.name} does not support import`)
  const dir = resolve(opts.dir)
  const input = new FileTicketSource({ dir })
  const all = await inventory(input)
  projectTicketTree(all, 'import')
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
  // Only actual input directories participate; virtual lifecycle defaults are harmless empty states.
  const directories: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      !entry.name.startsWith('.') &&
      (entry.isDirectory() ||
        (entry.isSymbolicLink() && (await stat(join(dir, entry.name))).isDirectory()))
    )
      directories.push(entry.name)
  }
  const problems: string[] = []
  const selection = selectTickets(opts, all, directories, manifest, problems)
  const { tickets } = selection
  if (
    !opts.source.integrationTree &&
    tickets.some((t) => t.kind === 'node' || t.target !== undefined)
  )
    throw new Error('target source cannot preserve kind/target metadata')
  if (!opts.source.issueLinks && tickets.some((t) => t.issueLinks?.length))
    throw new TicketIssueLinksUnsupported(opts.source.name)
  const bundles = new Map<string, PortableAsset[]>()
  for (const ticket of tickets) {
    const path = join(dir, ticket.state!, `${ticket.ref.id}.md`)
    bundles.set(
      ticket.ref.id,
      parseTicketFile(path, await readFile(path, 'utf8')).front.attachments ?? [],
    )
  }
  const keys = new Set<string>()
  for (const ticket of tickets) {
    const key =
      ticket.creationKey ??
      manifest.keys[ticket.ref.id] ??
      `migration:${manifest.identity}:${ticket.ref.id}`
    if (keys.has(key)) throw new Error(`duplicate creation key: ${key}`)
    keys.add(key)
    manifest.keys[ticket.ref.id] = key
  }
  // A source that allocates every id adopts committed creates inside `create`,
  // so only a requested-id policy needs the destination scanned for keys.
  const target = policy ? await inventory(opts.source) : []
  const byKey = new Map<string, Ticket>()
  for (const ticket of target)
    if (ticket.creationKey) {
      if (byKey.has(ticket.creationKey))
        throw new Error(`ambiguous target creation key: ${ticket.creationKey}`)
      byKey.set(ticket.creationKey, ticket)
    }
  const existingStates = (await opts.source.listStates()).map((state) => state.name)
  const states = planStates(selection.states, manifest, opts.lifecycle, existingStates, problems)
  if (!policy && !opts.source.readComments && tickets.some((t) => (t.comments?.length ?? 0) > 0))
    problems.push(`target ${opts.source.name} cannot read comment history`)
  if (opts.source.importProblems)
    problems.push(
      ...(await opts.source.importProblems({
        states: [...new Set(Object.values(states))],
        labels: [...new Set(tickets.flatMap((ticket) => ticket.labels))],
        creationKeys: [...keys],
      })),
    )
  if (problems.length)
    throw new Error(`import refused (no target changes):\n${[...new Set(problems)].join('\n')}`)
  const planned = new Map<string, string>()
  if (policy) {
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
  // Persist identities before the first target write, including for ordinary
  // layouts. The first save's time is the keys' reservation time, and a retry
  // reads it back unchanged.
  manifest.reservedAt ??= new Date().toISOString()
  await atomicJson(join(dir, MANIFEST), manifest)
  const mapping: Record<string, string> = Object.create(null)
  const mappingPath = join(dir, IMPORT_MAP)
  const saveMap = () =>
    atomicJson(mappingPath, { version: 1, identity: manifest.identity, states, tickets: mapping })
  await saveMap()
  // Links between the exported issues wait for their targets' new numbers.
  const linkIds = migrationSource(manifest) === 'github' ? new Set(all.map((t) => t.ref.id)) : null
  const createLinks = (ticket: Ticket) =>
    (ticket.issueLinks ?? []).filter((link) => !linkIds?.has(String(link.issue)))
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
      const links = createLinks(ticket)
      const result =
        byKey.get(key) ??
        (await opts.source.create(
          {
            title: ticket.title,
            body: ticket.body,
            labels: ticket.labels,
            ...(opts.source.integrationTree ? { kind: ticket.kind ?? 'work' } : {}),
            ...(opts.source.issueLinks && links.length ? { issueLinks: links } : {}),
          },
          {
            state: states[ticket.state!]!,
            idempotencyKey: key,
            idempotencyKeyReservedAt: manifest.reservedAt,
            ...(policy ? { requestedId: planned.get(ticket.ref.id)! } : {}),
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
    if (linkIds)
      for (const ticket of tickets) {
        const links = mappedIssueLinks(ticket.issueLinks, linkIds, mapping)
        if (JSON.stringify(links) !== JSON.stringify(createLinks(ticket)))
          await opts.source.update(mapping[ticket.ref.id]!, { issueLinks: links })
      }
    for (const ticket of tickets) {
      const id = mapping[ticket.ref.id]!
      for (const blocker of selection.blockers.get(ticket.ref.id) ?? [])
        await opts.source.addBlocker(id, mapping[blocker]!)
      // An explicit history read where the source has one, so `get` stays
      // comment-free on recurring paths.
      const history = opts.source.readComments
        ? await opts.source.readComments(id)
        : await opts.source.get(id).then((fresh) => (fresh === null ? null : fresh.comments))
      if (history === null) throw new Error(`target disappeared: ${id}`)
      if ((ticket.comments?.length ?? 0) && history === undefined)
        throw new Error(`target cannot read comment history: ${id}`)
      const bodies = new Set(history?.map((comment) => comment.body))
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
    return {
      identity: manifest.identity,
      from: migrationSource(manifest),
      to: opts.source.name,
      mapping,
    }
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : error}\nImport progress retained in ${mappingPath}; rerun import to finish.`,
    )
  }
}
