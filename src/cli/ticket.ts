/**
 * `ab ticket create` — the pre-build filing surface (SPEC §8.8): `/spec`
 * files a groomed ticket through the configured TicketSource, so the same
 * command lands in Linear or the file tracker per the repo's [tickets]
 * table. Runs OUTSIDE build sessions like init/upgrade (§16.3): it takes a
 * repo, not a build, and its secrets come from the process environment
 * (e.g. LINEAR_API_KEY via the binary's .env loader), never from config.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadConfig } from '../config/load'
import type { TicketsConfig } from '../config/schema'
import { createTicketSource } from '../ports/tickets/create'
import type { TicketSource } from '../ports/types'

export interface TicketCreateOpts {
  targetRepo: string
  title: string
  /** Path to the ticket body — the spec (docs/spec-standard.md). */
  bodyFile: string
  labels?: string[]
  /** Source-local ids of tickets that must complete before this one is
   * dispatched (§13). Validated against the configured source before create. */
  blockedBy?: string[]
  /** Process environment — adapter secrets (D8-adjacent, never in config). */
  env: Record<string, string | undefined>
  stdout: (line: string) => void
  /** Injectable for tests; defaults to the real adapter factory. */
  sourceFactory?: (
    config: TicketsConfig,
    env: Record<string, string | undefined>,
  ) => TicketSource
}

export async function abTicketCreate(opts: TicketCreateOpts): Promise<void> {
  const configPath = join(opts.targetRepo, 'autobuild.toml')
  let config
  try {
    config = await loadConfig(configPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${configPath}: not found — 'ab ticket create' reads the target repo's ` +
          'autobuild.toml (run it from the repo root, SPEC §8.8)',
      )
    }
    throw error
  }
  if (config.tickets === undefined) {
    throw new Error(
      "autobuild.toml has no [tickets] table — 'ab ticket create' files to the " +
        'configured TicketSource (SPEC §8.8); add [tickets] with ' +
        'source = "linear" (teamKey = "…") or source = "file" (dir = "…")',
    )
  }

  let body: string
  try {
    body = await readFile(opts.bodyFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `--body ${opts.bodyFile}: file not found — expected a file holding the ticket body`,
      )
    }
    throw error
  }

  // A relative [tickets].dir is relative to the repo, not to whatever cwd
  // this process happens to run from.
  const tickets =
    config.tickets.dir !== undefined
      ? { ...config.tickets, dir: resolve(opts.targetRepo, config.tickets.dir) }
      : config.tickets
  const factory = opts.sourceFactory ?? createTicketSource
  const source = factory(tickets, opts.env)

  // Validate blockers BEFORE creating: a ticket referencing a nonexistent
  // blocker would never dispatch, and failing here costs nothing, whereas
  // failing after create leaves a stranded ticket behind.
  const blockedBy = [...new Set(opts.blockedBy ?? [])]
  if (blockedBy.length > 0) {
    const states = await source.dependencyStates(blockedBy)
    const unknown = states.filter((state) => !state.exists).map((s) => s.id)
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
