/**
 * Source-agnostic pre-build ticket operations (SPEC §8.8). These commands run
 * outside build sessions and resolve the repository's configured TicketSource,
 * so the same CLI works for Linear and the file tracker. Adapter secrets come
 * from the process environment (for example LINEAR_API_KEY), never from config.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadConfig } from '../config/load'
import type { Config, TicketsConfig } from '../config/schema'
import { loadPlugins } from '../plugins/load'
import type { PluginRegistry } from '../plugins/registry'
import { createTicketSource } from '../ports/tickets/create'
import {
  changeBlockers,
  createTicket,
  moveTicket,
  requireTicket,
  ticketListCriteria,
  updateTicket,
} from '../ports/tickets/operations'
import type { Ticket, TicketSource, TicketStateInfo, TicketUpdate } from '../ports/types'
import { reduceBuild } from '../kernel/reducer'
import type { BuildStore } from '../store/types'
import { spawnExec, type Exec } from '../ports/workspace/git-worktree'
import type { TicketAssetSummary } from '../store/ticket-assets'
import { parseArgs, stringFlag } from './args'
import { resolveMainRepo, resolveRepoStatePaths } from './repo-state'
import { withSessionlessStore, type StoreOpener } from './store-opening'
import {
  buildAssetInput,
  formatAssetSize,
  ticketAssetNote,
  walkAssetPath,
  writeAssetTo,
} from './ticket-assets'

export type TicketSourceFactory = (
  config: TicketsConfig,
  env: Record<string, string | undefined>,
  targetRepo: string,
  localStateRoot: string | undefined,
  plugins: PluginRegistry,
) => TicketSource | Promise<TicketSource>

export interface TicketCommandOpts {
  targetRepo: string
  /** Process environment — store selection and adapter secrets. */
  env: Record<string, string | undefined>
  /** Git seam supplied by the CLI; omitted direct callers use targetRepo. */
  exec?: Exec
  stdout: (line: string) => void
  /** Injectable for tests; defaults to the real adapter factory. */
  sourceFactory?: TicketSourceFactory
  /** Store seam for the ticket-asset commands and `show`'s asset list. */
  openStore?: StoreOpener
  /** Explicit `--store` for the store-backed commands; precedence is applied
   * by repo-state.ts. */
  storeRef?: string
}

export interface TicketCreateOpts extends TicketCommandOpts {
  title: string
  json?: boolean
  /** Path to the ticket body — the spec (docs/spec-standard.md). */
  bodyFile: string
  labels?: string[]
  /** Source-local workflow state for this create; validation belongs to the
   * adapter. Omission preserves its configured/provider default. */
  state?: string
  /** Source-local ids of tickets that must complete before this one is
   * dispatched (§13). Validated against the configured source before create. */
  blockedBy?: string[]
}

export interface TicketUpdateOpts extends TicketCommandOpts {
  id: string
  json?: boolean
  title?: string
  /** Replacement body file. Omission preserves the current body. */
  bodyFile?: string
  /** Complete label replacement. An explicit [] clears labels. */
  labels?: string[]
}

export interface TicketBlockerOpts extends TicketCommandOpts {
  id: string
  blockerIds: string[]
  json?: boolean
}

export interface TicketListOpts extends TicketCommandOpts {
  /** Separate diagnostic sink so `--json` stdout remains one bare value. */
  stderr: (line: string) => void
  /** Source-local workflow state. Omitted with labels means any state. */
  state?: string
  /** Every requested label must match. Omitted with state means no label gate. */
  labels?: string[]
  json?: boolean
}

export interface TicketShowOpts extends TicketCommandOpts {
  id: string
  json?: boolean
}

export interface TicketAttachOpts extends TicketCommandOpts {
  id: string
  kind: string
  path: string
  /** Defaults to the path's basename. */
  name?: string
  json?: boolean
  /** Warning sink (active-build notice); stdout stays the command's result. */
  stderr?: (line: string) => void
}

export interface TicketAssetGetOpts extends TicketCommandOpts {
  id: string
  kind: string
  name: string
  dest: string
  rev?: number
  json?: boolean
}

export interface TicketAssetRmOpts extends TicketCommandOpts {
  id: string
  kind: string
  name: string
  json?: boolean
  /** Warning sink (active-build notice); stdout stays the command's result. */
  stderr?: (line: string) => void
}

export interface TicketMoveOpts extends TicketCommandOpts {
  id: string
  /** Source-local workflow state; validation belongs to the adapter. */
  state: string
  json?: boolean
}

export interface TicketStatesOpts extends TicketCommandOpts {
  json?: boolean
}

export interface TicketStateCreateOpts extends TicketCommandOpts {
  name: string
  /** One-line purpose; absent leaves an existing purpose untouched. */
  about?: string
  json?: boolean
}

type TicketCommandName =
  | 'states'
  | 'state create'
  | 'create'
  | 'update'
  | 'block'
  | 'unblock'
  | 'list'
  | 'show'
  | 'move'
  | 'attach'
  | 'asset get'
  | 'asset rm'

export interface ResolvedTicketCommand {
  config: Config
  source: TicketSource
}

/** Resolve linked-worktree identity, config, selected local state, and adapter
 * exactly once for one ticket command or another sessionless caller. */
export async function openTicketSource(
  opts: TicketCommandOpts & { storeRef?: string },
  label: string,
): Promise<ResolvedTicketCommand> {
  const targetRepo =
    opts.exec === undefined
      ? resolve(opts.targetRepo)
      : await resolveMainRepo(opts.targetRepo, opts.exec)
  const configPath = join(targetRepo, 'autobuild.toml')
  let config: Config
  try {
    config = await loadConfig(configPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${configPath}: not found — '${label}' reads autobuild.toml ` +
          'from the resolved Git main checkout (SPEC §8.8)',
      )
    }
    throw error
  }

  // Ticket commands use the same trusted plugin catalog as dispatch. Loading
  // and registration finish before any adapter is constructed or called.
  const plugins = await loadPlugins(config.plugins, targetRepo)
  const repoState = resolveRepoStatePaths({
    repo: targetRepo,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.env.AB_STORE !== undefined ? { envStore: opts.env.AB_STORE } : {}),
  })
  const factory = opts.sourceFactory ?? createTicketSource
  return {
    config,
    source: await factory(config.tickets, opts.env, targetRepo, repoState.localStateRoot, plugins),
  }
}

async function resolveTicketCommand(
  opts: TicketCommandOpts,
  command: TicketCommandName,
): Promise<ResolvedTicketCommand> {
  return openTicketSource(opts, `ab ticket ${command}`)
}

async function readBody(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`--body ${path}: file not found — expected a file holding the ticket body`)
    }
    throw error
  }
}

function ticketSummary(ticket: Ticket): string {
  const fields = [
    `${ticket.ref.source}:${ticket.ref.id}`,
    `(${ticket.state ?? 'state unknown'})`,
    `— ${ticket.title}`,
  ]
  if (ticket.labels.length > 0) fields.push(`— labels: ${ticket.labels.join(', ')}`)
  if (ticket.blockedBy !== undefined && ticket.blockedBy.length > 0) {
    fields.push(`— blocked by: ${ticket.blockedBy.join(', ')}`)
  }
  if (ticket.ref.url !== undefined) fields.push(`— ${ticket.ref.url}`)
  return fields.join(' ')
}

function assetLine(asset: TicketAssetSummary): string {
  return `    ${asset.kind}/${asset.name}  rev ${asset.revision}  ${formatAssetSize(asset.size)}`
}

function ticketDetail(ticket: Ticket, assets: TicketAssetSummary[] = []): string[] {
  const lines = [
    `ticket ${ticket.ref.source}:${ticket.ref.id}`,
    `  title:   ${ticket.title}`,
    `  state:   ${ticket.state ?? '(unknown)'}`,
    `  labels:  ${ticket.labels.join(', ') || '(none)'}`,
  ]
  if (ticket.blockedBy !== undefined && ticket.blockedBy.length > 0) {
    lines.push(`  blocked by: ${ticket.blockedBy.join(', ')}`)
  }
  if (ticket.ref.url !== undefined) lines.push(`  url:     ${ticket.ref.url}`)
  if (assets.length > 0) lines.push('  assets:', ...assets.map(assetLine))
  lines.push('  body:')
  return lines
}

function emitTicketJson(opts: TicketCommandOpts, ticket: Ticket): void {
  opts.stdout(JSON.stringify(ticket, null, 2))
}

export async function abTicketCreate(opts: TicketCreateOpts): Promise<void> {
  // Read the complete body before constructing or calling a mutable source.
  const body = await readBody(opts.bodyFile)
  const { source } = await resolveTicketCommand(opts, 'create')

  const ticket = await createTicket(
    source,
    {
      title: opts.title,
      body,
      ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
      ...(opts.blockedBy !== undefined ? { blockedBy: opts.blockedBy } : {}),
      ...(opts.state !== undefined ? { state: opts.state } : {}),
    },
    {
      blockerErrorPrefix: '--blocked-by: ',
      blockerErrorSuffix: ' (e.g. AUT-8 for linear, file-1 for file)',
    },
  )
  if (opts.json === true) {
    emitTicketJson(opts, ticket)
    return
  }
  const state = ticket.state ?? 'created'
  const url = ticket.ref.url !== undefined ? ` — ${ticket.ref.url}` : ''
  const blockers =
    ticket.blockedBy !== undefined && ticket.blockedBy.length > 0
      ? ` — blocked by ${ticket.blockedBy.join(', ')}`
      : ''
  opts.stdout(`ticket created: ${ticket.ref.source}:${ticket.ref.id} (${state})${blockers}${url}`)
}

export async function abTicketUpdate(opts: TicketUpdateOpts): Promise<void> {
  const body = opts.bodyFile === undefined ? undefined : await readBody(opts.bodyFile)
  const { source } = await resolveTicketCommand(opts, 'update')
  const patch: TicketUpdate = {
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(opts.labels !== undefined ? { labels: [...opts.labels] } : {}),
  }
  if (opts.json === true) {
    const updated = await updateTicket(source, opts.id, patch)
    if (updated !== null) emitTicketJson(opts, updated)
    return
  }
  await updateTicket(source, opts.id, patch, false)
  opts.stdout(`ticket updated: ${source.name}:${opts.id}`)
}

export async function abTicketBlock(opts: TicketBlockerOpts): Promise<void> {
  const { source } = await resolveTicketCommand(opts, 'block')
  const blockerIds = [...new Set(opts.blockerIds)]
  const updated = await changeBlockers(source, opts.id, blockerIds, 'block')
  if (opts.json === true) {
    emitTicketJson(opts, updated)
    return
  }
  opts.stdout(
    `ticket blocker added: ${source.name}:${opts.id} — blocked by ${blockerIds.join(', ')}`,
  )
}

export async function abTicketUnblock(opts: TicketBlockerOpts): Promise<void> {
  const { source } = await resolveTicketCommand(opts, 'unblock')
  const blockerIds = [...new Set(opts.blockerIds)]
  const updated = await changeBlockers(source, opts.id, blockerIds, 'unblock')
  if (opts.json === true) {
    emitTicketJson(opts, updated)
    return
  }
  opts.stdout(
    `ticket blocker removed: ${source.name}:${opts.id} — no longer blocked by ${blockerIds.join(', ')}`,
  )
}

/** `ab ticket list` — ready-to-dispatch by default, explicit criteria otherwise. */
export async function abTicketList(opts: TicketListOpts): Promise<void> {
  const { config, source } = await resolveTicketCommand(opts, 'list')
  const criteria = ticketListCriteria(config, {
    ...(opts.state !== undefined ? { state: opts.state } : {}),
    ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
  })
  const listing = await source.listReady(criteria)
  for (const diagnostic of listing.diagnostics) opts.stderr(diagnostic)
  if (opts.json === true) {
    opts.stdout(JSON.stringify(listing.tickets, null, 2))
    return
  }
  if (listing.tickets.length === 0) {
    opts.stdout(`no tickets matched in the configured ${source.name} ticket source`)
    return
  }
  for (const ticket of listing.tickets) opts.stdout(ticketSummary(ticket))
}

/** `ab ticket show <id>` — complete metadata plus the body/spec. */
export async function abTicketShow(opts: TicketShowOpts): Promise<void> {
  const { source } = await resolveTicketCommand(opts, 'show')
  const ticket = await requireTicket(source, opts.id)
  // An asset-listing failure fails the command rather than hiding the assets.
  const assets = await withTicketStore(opts, ({ store, repo }) =>
    store.listTicketAssets(repo, opts.id),
  )
  if (opts.json === true) {
    opts.stdout(
      JSON.stringify(
        {
          ...ticket,
          assets: assets.map(({ kind, name, revision, size, layout, fileCount }) => ({
            kind,
            name,
            revision,
            size,
            layout,
            fileCount,
          })),
        },
        null,
        2,
      ),
    )
    return
  }
  for (const line of ticketDetail(ticket, assets)) opts.stdout(line)
  // Keep the adapter-provided body untouched. It may itself be multiline and
  // may intentionally end (or not end) with a newline.
  opts.stdout(ticket.body)
}

function withTicketStore<T>(
  opts: TicketCommandOpts,
  use: (context: { store: BuildStore; repo: string }) => Promise<T>,
): Promise<T> {
  return withSessionlessStore(
    {
      targetRepo: opts.targetRepo,
      env: opts.env,
      exec: opts.exec ?? spawnExec,
      ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
      ...(opts.openStore !== undefined ? { openStore: opts.openStore } : {}),
    },
    use,
  )
}

/** Slugs of this repo's non-terminal builds for the ticket. A build freezes its
 * ticket assets at the claim (SPEC §6.3), so a change to them does not reach
 * it. The notice is advisory: a failed lookup yields none and never blocks. */
async function activeBuildsFor(store: BuildStore, repo: string, id: string): Promise<string[]> {
  try {
    const active: string[] = []
    for (const record of await store.listBuilds()) {
      if (record.repo !== repo || record.ticket?.id !== id) continue
      const { status } = reduceBuild(await store.getEvents(record.slug))
      if (status !== 'done' && status !== 'aborted') active.push(record.slug)
    }
    return active
  } catch {
    return []
  }
}

function warnActiveBuilds(
  opts: { stderr?: (line: string) => void; id: string },
  slugs: string[],
): void {
  for (const slug of slugs) {
    opts.stderr?.(
      `warning: build ${slug} is active for ticket ${opts.id}; it keeps the assets it froze at ` +
        `the claim unless its spec is revised from the ticket (ab answer ${slug} --revise-spec-from-ticket)`,
    )
  }
}

/** `ab ticket attach <id> <kind> <path>` — store a file or folder as a ticket
 * asset, then leave a note on the ticket in its source. Order matters: the
 * source is asked first, so an unknown id stores nothing; the note follows the
 * store write, so it never points at nothing. */
export async function abTicketAttach(opts: TicketAttachOpts): Promise<void> {
  const { source } = await resolveTicketCommand(opts, 'attach')
  await requireTicket(source, opts.id)
  const walk = await walkAssetPath(opts.path)
  const name = opts.name ?? walk.basename
  const stored = await withTicketStore(opts, async ({ store, repo }) => {
    const limits = await store.ticketAssetLimits(repo)
    const input = await buildAssetInput(walk, { kind: opts.kind, name }, limits)
    const live = await store.listTicketAssets(repo, opts.id)
    const replacing = live.some((asset) => asset.kind === opts.kind && asset.name === name)
    const meta = await store.putTicketAsset(repo, opts.id, input)
    return { meta, replacing, active: await activeBuildsFor(store, repo, opts.id) }
  })
  const { meta } = stored
  warnActiveBuilds(opts, stored.active)
  try {
    await source.comment(opts.id, ticketAssetNote(stored.replacing ? 'replaced' : 'attached', meta))
  } catch (error) {
    throw new Error(
      `ticket asset ${meta.kind}/${meta.name} was stored as revision ${meta.revision}, but the note on ` +
        `${source.name}:${opts.id} failed: ${error instanceof Error ? error.message : String(error)} ` +
        '(re-running attach stores another revision)',
    )
  }
  if (opts.json === true) {
    opts.stdout(JSON.stringify(meta, null, 2))
    return
  }
  opts.stdout(
    `ticket asset attached: ${source.name}:${opts.id} ${meta.kind}/${meta.name} revision ${meta.revision} ` +
      `(${formatAssetSize(meta.size)})`,
  )
}

/** `ab ticket asset get <id> <kind> <name> <dest>` — exact bytes at the
 * latest or a named revision. */
export async function abTicketAssetGet(opts: TicketAssetGetOpts): Promise<void> {
  const asset = await withTicketStore(opts, ({ store, repo }) =>
    store.getTicketAsset(repo, opts.id, opts.kind, opts.name, opts.rev),
  )
  if (asset === null) {
    const revision = opts.rev === undefined ? '' : ` revision ${opts.rev}`
    throw new Error(
      `ticket ${opts.id} has no asset ${opts.kind}/${opts.name}${revision}` +
        (opts.rev === undefined ? ' (it may have been removed — try --rev <n>)' : ''),
    )
  }
  const written = await writeAssetTo(asset, opts.dest)
  if (opts.json === true) {
    opts.stdout(JSON.stringify({ ...asset.meta, path: written }, null, 2))
    return
  }
  opts.stdout(
    `ticket asset downloaded: ${opts.kind}/${opts.name} revision ${asset.meta.revision} → ${written}`,
  )
}

/** `ab ticket asset rm <id> <kind> <name>` — remove from the current assets
 * (earlier revisions stay retrievable) and note the removal on the ticket. */
export async function abTicketAssetRm(opts: TicketAssetRmOpts): Promise<void> {
  const { source } = await resolveTicketCommand(opts, 'asset rm')
  const { removed, active } = await withTicketStore(opts, async ({ store, repo }) => ({
    removed: await store.removeTicketAsset(repo, opts.id, opts.kind, opts.name),
    active: await activeBuildsFor(store, repo, opts.id),
  }))
  if (removed === null) {
    throw new Error(`ticket ${opts.id} has no current asset ${opts.kind}/${opts.name} to remove`)
  }
  warnActiveBuilds(opts, active)
  try {
    await source.comment(opts.id, ticketAssetNote('removed', removed))
  } catch (error) {
    throw new Error(
      `ticket asset ${opts.kind}/${opts.name} was removed, but the note on ${source.name}:${opts.id} ` +
        `failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (opts.json === true) {
    opts.stdout(JSON.stringify(removed, null, 2))
    return
  }
  opts.stdout(`ticket asset removed: ${source.name}:${opts.id} ${opts.kind}/${opts.name}`)
}

/** `ab ticket move <id> <state>` — adapter-owned state validation and move. */
export async function abTicketMove(opts: TicketMoveOpts): Promise<void> {
  const { source } = await resolveTicketCommand(opts, 'move')
  const moved = await moveTicket(source, opts.id, opts.state)
  if (opts.json === true) {
    opts.stdout(JSON.stringify(moved, null, 2))
    return
  }
  opts.stdout(`ticket moved: ${ticketSummary(moved)}`)
}

export type TicketStateRole = 'create' | 'ready' | 'claimed' | 'triage' | 'proposal' | 'done'

export interface TicketStateRow extends TicketStateInfo {
  roles: TicketStateRole[]
}

/**
 * The lifecycle roles each state plays under `config`, for a source whose
 * states are directories (names match case-insensitively, as `ab ticket move`
 * does). The file adapter always claims into `doing`, so that is shown as
 * claimed whatever `[tickets].claimedState` says. Roles naming no existing
 * state are omitted.
 */
export function stateRoles(
  tickets: TicketsConfig,
  names: string[],
): Map<string, TicketStateRole[]> {
  const triage = tickets.triageState ?? 'triage'
  const named: Array<[TicketStateRole, string]> = [
    ['create', tickets.createState ?? 'triage'],
    ['ready', tickets.readyState],
    ['claimed', 'doing'],
    ['triage', triage],
    ['proposal', tickets.proposalState ?? triage],
    ['done', 'done'],
  ]
  const roles = new Map<string, TicketStateRole[]>(names.map((name) => [name, []]))
  for (const [role, target] of named) {
    const match =
      names.find((name) => name === target) ??
      names.find((name) => name.toLowerCase() === target.toLowerCase())
    if (match !== undefined) roles.get(match)?.push(role)
  }
  return roles
}

function stateRow(info: TicketStateInfo, roles: Map<string, TicketStateRole[]>): TicketStateRow {
  return {
    name: info.name,
    roles: roles.get(info.name) ?? [],
    tickets: info.tickets,
    ...(info.about !== undefined ? { about: info.about } : {}),
  }
}

function unsupported(source: TicketSource, operation: string): Error {
  return new Error(`ticket source "${source.name}" does not support ${operation}`)
}

/** `ab ticket states` — every state of the source, its roles, counts, purpose. */
export async function abTicketStates(opts: TicketStatesOpts): Promise<void> {
  const { config, source } = await resolveTicketCommand(opts, 'states')
  if (typeof source.listStates !== 'function') {
    throw unsupported(source, 'state discovery (ab ticket states)')
  }
  const infos = await source.listStates()
  const roles = stateRoles(
    config.tickets,
    infos.map((info) => info.name),
  )
  const rows = infos.map((info) => stateRow(info, roles))
  if (opts.json === true) {
    opts.stdout(JSON.stringify(rows, null, 2))
    return
  }
  const nameWidth = Math.max(...rows.map((row) => row.name.length))
  const roleText = rows.map((row) => (row.roles.length > 0 ? row.roles.join(',') : 'none'))
  const roleWidth = Math.max(...roleText.map((text) => text.length))
  rows.forEach((row, index) => {
    const count = `${row.tickets} ${row.tickets === 1 ? 'ticket' : 'tickets'}`
    const line = `${row.name.padEnd(nameWidth)}  ${(roleText[index] as string).padEnd(roleWidth)}  ${count}`
    opts.stdout(row.about === undefined ? line : `${line}  ${row.about}`)
  })
}

/** `ab ticket state create <name> [--about <text>]` — idempotent. */
export async function abTicketStateCreate(opts: TicketStateCreateOpts): Promise<void> {
  const { config, source } = await resolveTicketCommand(opts, 'state create')
  if (typeof source.addState !== 'function') {
    throw unsupported(source, 'state creation (ab ticket state create)')
  }
  const aboutBefore =
    opts.about === undefined
      ? undefined
      : (await source.listStates?.())?.find((info) => info.name === opts.name)?.about
  const { state, created } = await source.addState(opts.name, {
    ...(opts.about !== undefined ? { about: opts.about } : {}),
  })
  const names = (await source.listStates?.())?.map((info) => info.name) ?? [state.name]
  const row = stateRow(state, stateRoles(config.tickets, names))
  if (opts.json === true) {
    opts.stdout(JSON.stringify({ ...row, created }, null, 2))
    return
  }
  const purposeChanged = !created && opts.about !== undefined && state.about !== aboutBefore
  opts.stdout(
    created
      ? `ticket state created: ${state.name}`
      : `ticket state already exists: ${state.name}${purposeChanged ? ' (purpose updated)' : ''}`,
  )
}

const CREATE_USAGE =
  'usage: ab ticket create <title> --body <file> [--state <state>] [--labels a,b] [--blocked-by id,id] [--json] (§8.8)'
const UPDATE_USAGE =
  'usage: ab ticket update <id> [--title <title>] [--body <file>] [--labels a,b] [--json] (§8.8)'
const BLOCK_USAGE = 'usage: ab ticket block <id> <blocker-id[,blocker-id...]> [--json] (§8.8)'
const UNBLOCK_USAGE = 'usage: ab ticket unblock <id> <blocker-id[,blocker-id...]> [--json] (§8.8)'
const LIST_USAGE = 'usage: ab ticket list [--state <state>] [--labels a,b] [--json] (§8.8)'
const SHOW_USAGE = 'usage: ab ticket show <id> [--store <ref>] [--json] (§8.8)'
const ATTACH_USAGE =
  'usage: ab ticket attach <id> <kind> <path> [--name <name>] [--store <ref>] [--json] (§8.8)'
const ASSET_GET_USAGE =
  'usage: ab ticket asset get <id> <kind> <name> <dest> [--rev <n>] [--store <ref>] [--json] (§8.8)'
const ASSET_RM_USAGE =
  'usage: ab ticket asset rm <id> <kind> <name> [--store <ref>] [--json] (§8.8)'
const MOVE_USAGE = 'usage: ab ticket move <id> <state> [--json] (§8.8)'
const STATES_USAGE = 'usage: ab ticket states [--json] (§8.8)'
const STATE_CREATE_USAGE = 'usage: ab ticket state create <name> [--about <text>] [--json] (§8.8)'
export const TICKET_USAGE = [
  CREATE_USAGE,
  UPDATE_USAGE,
  BLOCK_USAGE,
  UNBLOCK_USAGE,
  LIST_USAGE,
  SHOW_USAGE,
  MOVE_USAGE,
  STATES_USAGE,
  STATE_CREATE_USAGE,
  ATTACH_USAGE,
  ASSET_GET_USAGE,
  ASSET_RM_USAGE,
].join('\n')

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

interface TicketCliOpts extends TicketCommandOpts {
  /** Required because the `list` subcommand can produce record diagnostics. */
  stderr: (line: string) => void
}

/** Parse and execute the complete ticket argv tail. Each subcommand supplies
 * only its own flags to the shared command-scoped parser. */
export async function abTicket(argv: string[], opts: TicketCliOpts): Promise<void> {
  const [command, ...args] = argv
  switch (command) {
    case 'create': {
      const parsed = parseArgs(
        args,
        { body: 'value', state: 'value', labels: 'value', 'blocked-by': 'value', json: 'boolean' },
        TICKET_USAGE,
      )
      const title = parsed.positionals.join(' ')
      const bodyFile = stringFlag(parsed, 'body')
      if (title.trim() === '' || bodyFile === undefined || bodyFile.trim() === '') {
        throw new Error(TICKET_USAGE)
      }
      const state = stringFlag(parsed, 'state')
      if (state !== undefined && state.trim() === '') throw new Error(TICKET_USAGE)
      const labels = stringFlag(parsed, 'labels')
      const blockedBy = stringFlag(parsed, 'blocked-by')
      await abTicketCreate({
        ...opts,
        title,
        bodyFile,
        ...(state !== undefined ? { state } : {}),
        ...(labels !== undefined ? { labels: commaList(labels) } : {}),
        ...(blockedBy !== undefined ? { blockedBy: commaList(blockedBy) } : {}),
        json: parsed.flags.has('json'),
      })
      return
    }

    case 'update': {
      const parsed = parseArgs(
        args,
        { title: 'value', body: 'value', labels: 'value', json: 'boolean' },
        TICKET_USAGE,
      )
      const [id, ...extra] = parsed.positionals
      const hasUpdate = ['title', 'body', 'labels'].some((flag) => parsed.flags.has(flag))
      if (id === undefined || id.trim() === '' || extra.length > 0 || !hasUpdate) {
        throw new Error(TICKET_USAGE)
      }
      const title = stringFlag(parsed, 'title')
      const bodyFile = stringFlag(parsed, 'body')
      const labels = stringFlag(parsed, 'labels')
      if (bodyFile !== undefined && bodyFile.trim() === '') {
        throw new Error(TICKET_USAGE)
      }
      await abTicketUpdate({
        ...opts,
        id,
        ...(title !== undefined ? { title } : {}),
        ...(bodyFile !== undefined ? { bodyFile } : {}),
        ...(labels !== undefined ? { labels: commaList(labels) } : {}),
        json: parsed.flags.has('json'),
      })
      return
    }

    case 'block':
    case 'unblock': {
      const parsed = parseArgs(args, { json: 'boolean' }, TICKET_USAGE)
      const [id, blockerList, ...extra] = parsed.positionals
      if (
        id === undefined ||
        id.trim() === '' ||
        blockerList === undefined ||
        blockerList.trim() === '' ||
        extra.length > 0
      ) {
        throw new Error(TICKET_USAGE)
      }
      const blockerIds = commaList(blockerList)
      if (blockerIds.length === 0) throw new Error(TICKET_USAGE)
      const blockerOpts = { ...opts, id, blockerIds, json: parsed.flags.has('json') }
      if (command === 'block') await abTicketBlock(blockerOpts)
      else await abTicketUnblock(blockerOpts)
      return
    }

    case 'list': {
      const parsed = parseArgs(
        args,
        { state: 'value', labels: 'value', json: 'boolean' },
        TICKET_USAGE,
      )
      if (parsed.positionals.length !== 0) throw new Error(TICKET_USAGE)
      const state = stringFlag(parsed, 'state')
      if (state !== undefined && state.trim() === '') throw new Error(TICKET_USAGE)
      const labels = stringFlag(parsed, 'labels')
      await abTicketList({
        ...opts,
        ...(state !== undefined ? { state } : {}),
        ...(labels !== undefined ? { labels: commaList(labels) } : {}),
        json: parsed.flags.has('json'),
      })
      return
    }

    case 'show': {
      const parsed = parseArgs(args, { json: 'boolean', store: 'value' }, TICKET_USAGE)
      const [id, ...extra] = parsed.positionals
      if (id === undefined || id.trim() === '' || extra.length > 0) {
        throw new Error(TICKET_USAGE)
      }
      const store = stringFlag(parsed, 'store')
      await abTicketShow({
        ...opts,
        ...(store !== undefined ? { storeRef: store } : {}),
        id,
        json: parsed.flags.has('json'),
      })
      return
    }

    case 'attach': {
      const parsed = parseArgs(
        args,
        { name: 'value', store: 'value', json: 'boolean' },
        TICKET_USAGE,
      )
      const [id, kind, path, ...extra] = parsed.positionals
      if (!id?.trim() || !kind?.trim() || !path?.trim() || extra.length > 0) {
        throw new Error(TICKET_USAGE)
      }
      const name = stringFlag(parsed, 'name')
      if (name !== undefined && name.trim() === '') throw new Error(TICKET_USAGE)
      const store = stringFlag(parsed, 'store')
      await abTicketAttach({
        ...opts,
        ...(store !== undefined ? { storeRef: store } : {}),
        id,
        kind,
        path,
        ...(name !== undefined ? { name } : {}),
        json: parsed.flags.has('json'),
      })
      return
    }

    case 'asset': {
      const [action, ...assetArgs] = args
      if (action === 'get') {
        const parsed = parseArgs(
          assetArgs,
          { rev: 'value', store: 'value', json: 'boolean' },
          TICKET_USAGE,
        )
        const [id, kind, name, dest, ...extra] = parsed.positionals
        if (!id?.trim() || !kind?.trim() || !name?.trim() || !dest?.trim() || extra.length > 0) {
          throw new Error(TICKET_USAGE)
        }
        const rawRev = stringFlag(parsed, 'rev')
        if (rawRev !== undefined && !/^\d+$/.test(rawRev)) {
          throw new Error(
            `--rev must be a nonnegative integer, got "${rawRev}" — ${ASSET_GET_USAGE}`,
          )
        }
        const store = stringFlag(parsed, 'store')
        await abTicketAssetGet({
          ...opts,
          ...(store !== undefined ? { storeRef: store } : {}),
          id,
          kind,
          name,
          dest,
          ...(rawRev !== undefined ? { rev: Number(rawRev) } : {}),
          json: parsed.flags.has('json'),
        })
        return
      }
      if (action === 'rm') {
        const parsed = parseArgs(assetArgs, { store: 'value', json: 'boolean' }, TICKET_USAGE)
        const [id, kind, name, ...extra] = parsed.positionals
        if (!id?.trim() || !kind?.trim() || !name?.trim() || extra.length > 0) {
          throw new Error(TICKET_USAGE)
        }
        const store = stringFlag(parsed, 'store')
        await abTicketAssetRm({
          ...opts,
          ...(store !== undefined ? { storeRef: store } : {}),
          id,
          kind,
          name,
          json: parsed.flags.has('json'),
        })
        return
      }
      throw new Error(TICKET_USAGE)
    }

    case 'states': {
      const parsed = parseArgs(args, { json: 'boolean' }, TICKET_USAGE)
      if (parsed.positionals.length !== 0) throw new Error(STATES_USAGE)
      await abTicketStates({ ...opts, json: parsed.flags.has('json') })
      return
    }

    case 'state': {
      const [action, ...stateArgs] = args
      if (action !== 'create') throw new Error(STATE_CREATE_USAGE)
      const parsed = parseArgs(stateArgs, { about: 'value', json: 'boolean' }, TICKET_USAGE)
      const [name, ...extra] = parsed.positionals
      if (name === undefined || name.trim() === '' || extra.length > 0) {
        throw new Error(STATE_CREATE_USAGE)
      }
      const about = stringFlag(parsed, 'about')
      if (about !== undefined && about.trim() === '') throw new Error(STATE_CREATE_USAGE)
      await abTicketStateCreate({
        ...opts,
        name,
        ...(about !== undefined ? { about } : {}),
        json: parsed.flags.has('json'),
      })
      return
    }

    case 'move': {
      const parsed = parseArgs(args, { json: 'boolean' }, TICKET_USAGE)
      const [id, state, ...extra] = parsed.positionals
      if (
        id === undefined ||
        id.trim() === '' ||
        state === undefined ||
        state.trim() === '' ||
        extra.length > 0
      ) {
        throw new Error(TICKET_USAGE)
      }
      await abTicketMove({
        ...opts,
        id,
        state,
        json: parsed.flags.has('json'),
      })
      return
    }

    default:
      throw new Error(TICKET_USAGE)
  }
}
