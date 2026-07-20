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
import { createTicketSource } from '../ports/tickets/create'
import type {
  Ticket,
  TicketSource,
  TicketUpdate,
} from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import { readyCriteria } from '../processes/dispatcher'
import { parseArgs, stringFlag } from './args'
import { resolveMainRepo, resolveRepoStatePaths } from './repo-state'

export type TicketSourceFactory = (
  config: TicketsConfig,
  env: Record<string, string | undefined>,
  targetRepo: string,
  localStateRoot?: string,
) => TicketSource

interface TicketCommandOpts {
  targetRepo: string
  /** Process environment — store selection and adapter secrets. */
  env: Record<string, string | undefined>
  /** Git seam supplied by the CLI; omitted direct callers use targetRepo. */
  exec?: Exec
  stdout: (line: string) => void
  /** Injectable for tests; defaults to the real adapter factory. */
  sourceFactory?: TicketSourceFactory
}

export interface TicketCreateOpts extends TicketCommandOpts {
  title: string
  /** Path to the ticket body — the spec (docs/spec-standard.md). */
  bodyFile: string
  labels?: string[]
  /** Source-local ids of tickets that must complete before this one is
   * dispatched (§13). Validated against the configured source before create. */
  blockedBy?: string[]
}

export interface TicketUpdateOpts extends TicketCommandOpts {
  id: string
  title?: string
  /** Replacement body file. Omission preserves the current body. */
  bodyFile?: string
  /** Complete label replacement. An explicit [] clears labels. */
  labels?: string[]
}

export interface TicketBlockerOpts extends TicketCommandOpts {
  id: string
  blockerId: string
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

export interface TicketMoveOpts extends TicketCommandOpts {
  id: string
  /** Source-local workflow state; validation belongs to the adapter. */
  state: string
  json?: boolean
}

type TicketCommandName =
  | 'create'
  | 'update'
  | 'block'
  | 'unblock'
  | 'list'
  | 'show'
  | 'move'

interface ResolvedTicketCommand {
  config: Config
  source: TicketSource
}

/** Resolve linked-worktree identity, config, selected local state, and adapter
 * exactly once for one ticket command. */
async function resolveTicketCommand(
  opts: TicketCommandOpts,
  command: TicketCommandName,
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
        `${configPath}: not found — 'ab ticket ${command}' reads autobuild.toml ` +
          'from the resolved Git main checkout (SPEC §8.8)',
      )
    }
    throw error
  }

  const repoState = resolveRepoStatePaths({
    repo: targetRepo,
    ...(opts.env['AB_STORE'] !== undefined
      ? { envStore: opts.env['AB_STORE'] }
      : {}),
  })
  const factory = opts.sourceFactory ?? createTicketSource
  return {
    config,
    source: factory(
      config.tickets,
      opts.env,
      targetRepo,
      repoState.localStateRoot,
    ),
  }
}

async function readBody(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `--body ${path}: file not found — expected a file holding the ticket body`,
      )
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

function ticketDetail(ticket: Ticket): string[] {
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
  lines.push('  body:')
  return lines
}

function missingTicket(source: TicketSource, id: string): Error {
  return new Error(
    `no ticket "${id}" in the configured ${source.name} ticket source — ` +
      'ticket ids are source-local',
  )
}

async function requireTicket(source: TicketSource, id: string): Promise<Ticket> {
  const ticket = await source.get(id)
  if (ticket === null) throw missingTicket(source, id)
  return ticket
}

export async function abTicketCreate(opts: TicketCreateOpts): Promise<void> {
  // Read the complete body before constructing or calling a mutable source.
  const body = await readBody(opts.bodyFile)
  const { source } = await resolveTicketCommand(opts, 'create')

  // Validate blockers BEFORE creating: a ticket referencing a nonexistent
  // blocker would never dispatch, and failing here costs nothing, whereas
  // failing after create leaves a stranded ticket behind.
  const blockedBy = [...new Set(opts.blockedBy ?? [])]
  if (blockedBy.length > 0) {
    const states = await source.dependencyStates(blockedBy)
    const unknown = states.filter((state) => !state.exists).map((state) => state.id)
    if (unknown.length > 0) {
      throw new Error(
        `--blocked-by: no ticket ${unknown.map((id) => `"${id}"`).join(', ')} ` +
          `in the configured ${source.name} ticket source — blocker ids are ` +
          'source-local (e.g. AUT-8 for linear, file-1 for file)',
      )
    }
  }

  const ticket = await source.create({
    title: opts.title,
    body,
    ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
  })
  const state = ticket.state ?? 'created'
  const url = ticket.ref.url !== undefined ? ` — ${ticket.ref.url}` : ''
  const blockers =
    ticket.blockedBy !== undefined && ticket.blockedBy.length > 0
      ? ` — blocked by ${ticket.blockedBy.join(', ')}`
      : ''
  opts.stdout(
    `ticket created: ${ticket.ref.source}:${ticket.ref.id} (${state})${blockers}${url}`,
  )
}

export async function abTicketUpdate(opts: TicketUpdateOpts): Promise<void> {
  const body =
    opts.bodyFile === undefined ? undefined : await readBody(opts.bodyFile)
  const { source } = await resolveTicketCommand(opts, 'update')
  const patch: TicketUpdate = {
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(opts.labels !== undefined ? { labels: [...opts.labels] } : {}),
  }
  await source.update(opts.id, patch)
  opts.stdout(`ticket updated: ${source.name}:${opts.id}`)
}

export async function abTicketBlock(opts: TicketBlockerOpts): Promise<void> {
  const { source } = await resolveTicketCommand(opts, 'block')
  await source.addBlocker(opts.id, opts.blockerId)
  opts.stdout(
    `ticket blocker added: ${source.name}:${opts.id} — blocked by ${opts.blockerId}`,
  )
}

export async function abTicketUnblock(opts: TicketBlockerOpts): Promise<void> {
  const { source } = await resolveTicketCommand(opts, 'unblock')
  await source.removeBlocker(opts.id, opts.blockerId)
  opts.stdout(
    `ticket blocker removed: ${source.name}:${opts.id} — no longer blocked by ${opts.blockerId}`,
  )
}

/** `ab ticket list` — ready-to-dispatch by default, explicit criteria otherwise. */
export async function abTicketList(opts: TicketListOpts): Promise<void> {
  const { config, source } = await resolveTicketCommand(opts, 'list')
  const criteria =
    opts.state === undefined && opts.labels === undefined
      ? readyCriteria(config)
      : {
          ...(opts.state !== undefined ? { state: opts.state } : {}),
          ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
        }
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
  if (opts.json === true) {
    opts.stdout(JSON.stringify(ticket, null, 2))
    return
  }
  for (const line of ticketDetail(ticket)) opts.stdout(line)
  // Keep the adapter-provided body untouched. It may itself be multiline and
  // may intentionally end (or not end) with a newline.
  opts.stdout(ticket.body)
}

/** `ab ticket move <id> <state>` — adapter-owned state validation and move. */
export async function abTicketMove(opts: TicketMoveOpts): Promise<void> {
  const { source } = await resolveTicketCommand(opts, 'move')
  await requireTicket(source, opts.id)
  await source.transition(opts.id, opts.state)
  const moved = await source.get(opts.id)
  if (moved === null) {
    throw new Error(
      `ticket "${opts.id}" disappeared from the configured ${source.name} ` +
        'ticket source after the move',
    )
  }
  if (opts.json === true) {
    opts.stdout(JSON.stringify(moved, null, 2))
    return
  }
  opts.stdout(`ticket moved: ${ticketSummary(moved)}`)
}

const CREATE_USAGE =
  'usage: ab ticket create <title> --body <file> [--labels a,b] [--blocked-by id,id] (§8.8)'
const UPDATE_USAGE =
  'usage: ab ticket update <id> [--title <title>] [--body <file>] [--labels a,b] (§8.8)'
const BLOCK_USAGE = 'usage: ab ticket block <id> <blocker-id> (§8.8)'
const UNBLOCK_USAGE = 'usage: ab ticket unblock <id> <blocker-id> (§8.8)'
const LIST_USAGE =
  'usage: ab ticket list [--state <state>] [--labels a,b] [--json] (§8.8)'
const SHOW_USAGE = 'usage: ab ticket show <id> [--json] (§8.8)'
const MOVE_USAGE = 'usage: ab ticket move <id> <state> [--json] (§8.8)'
export const TICKET_USAGE = [
  CREATE_USAGE,
  UPDATE_USAGE,
  BLOCK_USAGE,
  UNBLOCK_USAGE,
  LIST_USAGE,
  SHOW_USAGE,
  MOVE_USAGE,
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
export async function abTicket(
  argv: string[],
  opts: TicketCliOpts,
): Promise<void> {
  const [command, ...args] = argv
  switch (command) {
    case 'create': {
      const parsed = parseArgs(
        args,
        { body: 'value', labels: 'value', 'blocked-by': 'value' },
        TICKET_USAGE,
      )
      const title = parsed.positionals.join(' ')
      const bodyFile = stringFlag(parsed, 'body')
      if (
        title.trim() === '' ||
        bodyFile === undefined ||
        bodyFile.trim() === ''
      ) {
        throw new Error(TICKET_USAGE)
      }
      const labels = stringFlag(parsed, 'labels')
      const blockedBy = stringFlag(parsed, 'blocked-by')
      await abTicketCreate({
        ...opts,
        title,
        bodyFile,
        ...(labels !== undefined ? { labels: commaList(labels) } : {}),
        ...(blockedBy !== undefined
          ? { blockedBy: commaList(blockedBy) }
          : {}),
      })
      return
    }

    case 'update': {
      const parsed = parseArgs(
        args,
        { title: 'value', body: 'value', labels: 'value' },
        TICKET_USAGE,
      )
      const [id, ...extra] = parsed.positionals
      if (
        id === undefined ||
        id.trim() === '' ||
        extra.length > 0 ||
        parsed.flags.size === 0
      ) {
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
      })
      return
    }

    case 'block':
    case 'unblock': {
      const parsed = parseArgs(args, {}, TICKET_USAGE)
      const [id, blockerId, ...extra] = parsed.positionals
      if (
        id === undefined ||
        id.trim() === '' ||
        blockerId === undefined ||
        blockerId.trim() === '' ||
        extra.length > 0
      ) {
        throw new Error(TICKET_USAGE)
      }
      const blockerOpts = { ...opts, id, blockerId }
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
      const parsed = parseArgs(args, { json: 'boolean' }, TICKET_USAGE)
      const [id, ...extra] = parsed.positionals
      if (id === undefined || id.trim() === '' || extra.length > 0) {
        throw new Error(TICKET_USAGE)
      }
      await abTicketShow({
        ...opts,
        id,
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
