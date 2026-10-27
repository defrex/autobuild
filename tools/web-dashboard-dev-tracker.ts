/**
 * Real ticket fixtures for `tools/web-dashboard-dev.ts`, read at seed time
 * from this repository's own file tracker (`.autobuild/tickets`, ignored by
 * git) so the local web app shows specs at their true length and shape.
 * Nothing from the tracker is copied into the repository.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DevTicket } from './web-dashboard-dev-tickets'

export interface TrackerTicket {
  id: string
  title: string
  body: string
  /** The tracker directory the ticket lives in: triage, doing, done, icebox... */
  directory: string
  kind?: 'work' | 'node'
  labels: string[]
  blockedBy: string[]
  comments: { body: string; createdAt: string }[]
  /** The most recent build slug its comments record, if any. */
  slug?: string
}

/** Bodies past this are pathological for a design session, not representative. */
const MAX_BODY = 24_000

export function readTracker(root: string): Map<string, TrackerTicket> {
  const tickets = new Map<string, TrackerTicket>()
  for (const directory of readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue
    for (const file of readdirSync(join(root, directory.name))) {
      if (!file.endsWith('.md')) continue
      const text = readFileSync(join(root, directory.name, file), 'utf8')
      const match = text.match(/^\+\+\+\n([\s\S]*?)\n\+\+\+\n?([\s\S]*)$/)
      if (!match) continue
      const front = Bun.TOML.parse(match[1]!) as {
        id?: string
        title?: string
        kind?: 'work' | 'node'
        labels?: string[]
        blockedBy?: string[]
        comments?: { body: string; createdAt: string }[]
      }
      if (!front.id || !front.title) continue
      const comments = front.comments ?? []
      const slug = comments
        .map((comment) => comment.body.match(/^build (\S+) dispatched/)?.[1])
        .filter((value): value is string => value !== undefined)
        .at(-1)
      tickets.set(front.id, {
        id: front.id,
        title: front.title,
        body: match[2]!.trim(),
        directory: directory.name,
        ...(front.kind ? { kind: front.kind } : {}),
        labels: front.labels ?? [],
        blockedBy: front.blockedBy ?? [],
        comments,
        ...(slug ? { slug } : {}),
      })
    }
  }
  return tickets
}

/** Newest first: `file-N` tickets postdate every `AUT-N` one. */
function recency(ticket: TrackerTicket): number {
  const n = Number(ticket.id.split('-').at(-1))
  return ticket.id.startsWith('file-') ? 1_000_000 + n : n
}

function usable(ticket: TrackerTicket): boolean {
  return ticket.body.length > 0 && ticket.body.length <= MAX_BODY
}

export function newest(
  tickets: Map<string, TrackerTicket>,
  directory: string,
  count: number,
  skip = 0,
): TrackerTicket[] {
  return [...tickets.values()]
    .filter((ticket) => ticket.directory === directory && usable(ticket))
    .sort((a, b) => recency(b) - recency(a))
    .slice(skip, skip + count)
}

/** `count` done tickets from the 20th to the 98th length percentile, shortest first. */
export function lengthSpread(
  tickets: Map<string, TrackerTicket>,
  count: number,
  exclude: Set<string>,
): TrackerTicket[] {
  const pool = [...tickets.values()]
    .filter((t) => t.directory === 'done' && usable(t) && !exclude.has(t.id))
    .sort((a, b) => a.body.length - b.body.length)
  return Array.from({ length: count }, (_, i) => {
    const percentile = 0.2 + (0.78 * i) / Math.max(1, count - 1)
    return pool[Math.min(pool.length - 1, Math.floor(percentile * pool.length))]!
  })
}

export interface TrackerFixture {
  tickets: DevTicket[]
  /** Scenario titles and slugs rewritten to the real ticket's, longest first. */
  replacements: [string, string][]
}

/**
 * Assign real tickets to fixture ids and states. `builds` pairs each replayed
 * build's fixture ticket id, scenario title and scenario slug with the real
 * ticket that takes its place; every other ticket gets a fresh number under
 * `teamKey` so ids stay hosted-shaped.
 */
export function trackerFixture(opts: {
  teamKey: string
  builds: { id: string; title: string; slug: string; real: TrackerTicket }[]
  states: { state: DevTicket['state']; tickets: TrackerTicket[] }[]
  firstNumber: number
}): TrackerFixture {
  const ids = new Map<string, string>()
  for (const build of opts.builds) ids.set(build.real.id, build.id)
  let next = opts.firstNumber
  for (const { tickets } of opts.states)
    for (const ticket of tickets)
      if (!ids.has(ticket.id)) ids.set(ticket.id, `${opts.teamKey}-${next++}`)

  const fixture = (ticket: TrackerTicket, state: DevTicket['state']): DevTicket => ({
    id: ids.get(ticket.id)!,
    state,
    title: ticket.title,
    body: ticket.body,
    labels: ticket.labels,
    // Only blockers that are themselves seeded survive the renumbering.
    blockedBy: ticket.blockedBy.flatMap((id) => (ids.has(id) ? [ids.get(id)!] : [])),
    // An active build's ticket keeps its history up to dispatch, not its later merge.
    comments:
      state === 'doing'
        ? ticket.comments.filter((c) => !/^build \S+ (merged|closed|aborted)/.test(c.body))
        : ticket.comments,
    ...(ticket.kind ? { kind: ticket.kind } : {}),
  })
  const unordered = [
    ...opts.builds.map((build) => fixture(build.real, 'doing')),
    ...opts.states.flatMap(({ state, tickets }) => tickets.map((t) => fixture(t, state))),
  ]
  // Blockers are created before the tickets they block.
  const tickets: DevTicket[] = []
  const placed = new Set<string>()
  while (tickets.length < unordered.length) {
    const ready = unordered.filter(
      (t) => !placed.has(t.id) && (t.blockedBy ?? []).every((id) => placed.has(id)),
    )
    if (!ready.length) throw new Error('tracker fixture: blocker cycle among seeded tickets')
    for (const ticket of ready) {
      tickets.push(ticket)
      placed.add(ticket.id)
    }
  }

  const replacements: [string, string][] = opts.builds.flatMap((build) => [
    [build.title, build.real.title] as [string, string],
    ...(build.real.slug ? [[build.slug, build.real.slug] as [string, string]] : []),
  ])
  replacements.sort((a, b) => b[0].length - a[0].length)
  return { tickets, replacements }
}

export function trackerRoot(repoRoot: string): string | undefined {
  const configured = process.env.AB_WEB_DEV_TICKETS
  if (configured) return existsSync(configured) ? configured : undefined
  // A worktree's tracker lives in the main checkout beside the shared git dir.
  const common = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repoRoot,
  })
  const gitDir = common.stdout.toString().trim()
  const candidates = [join(repoRoot, '.autobuild', 'tickets')]
  if (gitDir) candidates.push(join(gitDir, '..', '.autobuild', 'tickets'))
  return candidates.find((path) => existsSync(path))
}
