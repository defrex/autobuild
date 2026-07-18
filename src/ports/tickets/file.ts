/**
 * File-based TicketSource (SPEC §3.2, §13): the default tracker. A directory
 * of state directories — `triage/ ready/ doing/ done/` — each holding
 * `<id>.md` files: TOML frontmatter between `+++` fences, then the ticket
 * body, where the spec lives pre-build (§6.3). This adapter is the policy's
 * proof: a source with nowhere to put blobs must be fully workable, because
 * the tracker initiates and receives projections only — never consulted
 * mid-build, never artifact storage.
 *
 * A ticket's state IS the directory it sits in. There is no `state` field to
 * disagree with the filesystem, `transition` and `claim` are rename(2), and
 * `ls ready/` is an accurate answer to "what's dispatchable" — which is what
 * lets `mv triage/x.md ready/` be the whole grooming UX.
 *
 * Concurrency: claim (and every other write) is locate-check-rename, not a
 * filesystem lock. That is atomic *enough* by design — the dispatcher is the
 * single writer (SPEC §12 single-writer discipline), so the guard defends
 * against re-dispatch across runs, not against concurrent writers. The rename
 * never crosses a filesystem: `<dir>/ready` → `<dir>/doing` is one mount by
 * construction.
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { z } from 'zod'
import { systemClock, type Clock } from '../../store/types'
import type {
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketSource,
} from '../types'

/**
 * The canonical states, in workflow order. This set is closed: the states are
 * directories, and a tracker whose states are discoverable by `ls` cannot also
 * let config invent new ones.
 */
export const TICKET_STATES = ['Triage', 'Ready', 'Doing', 'Done'] as const
export type TicketState = (typeof TICKET_STATES)[number]

/** Where a repo's tracker lives when [tickets].dir is absent (SPEC §16.1). */
export const DEFAULT_TICKETS_DIR = '.autobuild/tickets'

/**
 * Canonicalize a state name to its directory. Case-insensitive in (a config's
 * `readyState = "ready"` means the `ready/` directory), canonical out — and
 * anything else is a loud error, because a typo'd state must not silently
 * create a fifth directory no `ls` of the four would ever show.
 */
export function stateDir(state: string): TicketState {
  const match = TICKET_STATES.find((s) => s.toLowerCase() === state.toLowerCase())
  if (match === undefined) {
    throw new Error(
      `file ticket source: unknown state "${state}" — this tracker's states are ` +
        `the directories: ${TICKET_STATES.join(', ')}`,
    )
  }
  return match
}

function dirName(state: TicketState): string {
  return state.toLowerCase()
}

const frontmatterSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  labels: z.array(z.string()).default([]),
  /** Source-local blocker ids (§13). Absent ≡ no dependencies, which keeps
   * every pre-existing ticket file valid. */
  blockedBy: z.array(z.string()).optional(),
  /** Stable external-create adoption key. It travels with the ticket across
   * state-directory moves, so retries find it in any lifecycle state. */
  idempotencyKey: z.string().min(1).optional(),
})
type Frontmatter = z.infer<typeof frontmatterSchema>

const OPEN_FENCE = '+++\n'
const CLOSE_FENCE = '\n+++\n'

function parseTicketFile(
  path: string,
  raw: string,
): { front: Frontmatter; body: string } {
  if (!raw.startsWith(OPEN_FENCE)) {
    throw new Error(`${path}: malformed ticket file — missing opening "+++" fence`)
  }
  const close = raw.indexOf(CLOSE_FENCE, OPEN_FENCE.length)
  if (close === -1) {
    throw new Error(`${path}: malformed ticket file — missing closing "+++" fence`)
  }
  let parsed: unknown
  try {
    parsed = parseToml(raw.slice(OPEN_FENCE.length, close))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${path}: malformed TOML frontmatter — ${message}`)
  }
  const result = frontmatterSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(`${path}: invalid frontmatter — ${issues}`)
  }
  return { front: result.data, body: raw.slice(close + CLOSE_FENCE.length) }
}

function serializeTicketFile(front: Frontmatter, body: string): string {
  const data: Record<string, unknown> = { id: front.id, title: front.title }
  if (front.labels.length > 0) data.labels = front.labels
  // Only when nonempty: a file that never declared blockers must round-trip
  // byte-identically rather than sprouting `blockedBy = []` on every write.
  if (front.blockedBy !== undefined && front.blockedBy.length > 0) {
    data.blockedBy = front.blockedBy
  }
  if (front.idempotencyKey !== undefined) {
    data.idempotencyKey = front.idempotencyKey
  }
  // smol-toml stringify ends with a newline; the closing fence follows it.
  return `${OPEN_FENCE}${stringifyToml(data)}+++\n${body}`
}

/** A ticket file found on disk: its id, its state (= its directory), its path. */
interface Located {
  id: string
  state: TicketState
  path: string
}

export class FileTicketSource implements TicketSource {
  readonly name = 'file'

  private readonly dir: string
  private readonly clock: Clock
  private readonly createState: TicketState
  private readonly doneState: TicketState
  private readonly selfIgnore: boolean

  constructor(opts: {
    dir: string
    /** Injectable for deterministic comment timestamps. */
    clock?: Clock
    /** State assigned by create — proposals land in Triage (SPEC §12). */
    createState?: string
    /**
     * The state this source considers complete, for dependency resolution
     * (§13: this adapter's native lifecycle). Default 'Done' — and, like every
     * state here, it names a directory, so it is canonicalized rather than
     * compared raw.
     */
    doneState?: string
    /**
     * Write a self-excluding `<dir>/.gitignore`. Set ONLY for the defaulted
     * `.autobuild/tickets` backlog (see createTicketSource): an explicitly
     * configured dir is the user's directory, and ab does not decide git's
     * view of it.
     */
    selfIgnore?: boolean
  }) {
    this.dir = opts.dir
    this.clock = opts.clock ?? systemClock
    this.createState = stateDir(opts.createState ?? 'Triage')
    this.doneState = stateDir(opts.doneState ?? 'Done')
    this.selfIgnore = opts.selfIgnore ?? false
  }

  async listReady(criteria: { labels?: string[]; state?: string }): Promise<Ticket[]> {
    const labels = criteria.labels ?? []
    const state = criteria.state === undefined ? undefined : stateDir(criteria.state)
    // Through listAll, not a single readdir: the duplicate-id check has to hold
    // on the SCAN path, or a `cp` between state dirs is a silent double-dispatch.
    const tickets = await this.listAll()
    return tickets.filter(
      (ticket) =>
        (state === undefined || ticket.state === state) &&
        labels.every((label) => ticket.labels.includes(label)),
    )
  }

  async get(id: string): Promise<Ticket | null> {
    const found = await this.locate(id)
    if (found === null) return null
    const loaded = await this.loadAt(found)
    return this.toTicket(loaded.front, loaded.body, found.state)
  }

  /**
   * Claim-before-launch (SPEC §12): rename into `doing/`. The relocation IS
   * the claim record — no `claimedBy` field, which is what makes "claiming
   * visibly removes it from ready/" true.
   *
   * The guard refuses a ticket ALREADY in Doing/Done rather than requiring one
   * in Ready. That inversion is deliberate: a legal `[tickets] readyState =
   * "Triage"` would otherwise stall forever — listReady would yield triage/
   * tickets and every claim would refuse them. Refusing Doing/Done is
   * sufficient for both obligations: the ticket leaves ready/, and it cannot be
   * claimed twice.
   */
  async claim(id: string): Promise<boolean> {
    await this.ensureLayout()
    const found = await this.locate(id)
    if (found === null) return false
    if (found.state === 'Doing' || found.state === 'Done') return false
    await rename(found.path, this.pathIn('Doing', id))
    return true
  }

  /**
   * Projections flow outward only (SPEC §13): the comment is appended below
   * the existing content, which is preserved byte-exactly — the spec in the
   * body (§6.3) is never rewritten.
   */
  async comment(id: string, body: string): Promise<void> {
    await this.ensureLayout()
    const found = await this.locate(id)
    if (found === null) {
      throw new Error(`file ticket source: comment on unknown ticket "${id}"`)
    }
    const raw = await readFile(found.path, 'utf8')
    parseTicketFile(found.path, raw) // surface malformed files before appending
    const separator = raw.endsWith('\n') ? '\n' : '\n\n'
    const stamp = this.clock().toISOString()
    await writeFile(found.path, `${raw}${separator}## Comment (${stamp})\n\n${body}\n`)
  }

  /** A move, never a rewrite — which is why the body survives byte-exactly. */
  async transition(id: string, state: string): Promise<void> {
    await this.ensureLayout()
    const target = stateDir(state)
    const found = await this.locate(id)
    if (found === null) {
      throw new Error(`file ticket source: transition on unknown ticket "${id}"`)
    }
    // Idempotent by construction — the dispatcher retries transitions after a
    // crash (file.test.ts explains the window). rename(2) would no-op here
    // anyway, but resting idempotency on that POSIX subtlety would make it a
    // property of the syscall rather than of this adapter.
    if (found.state === target) return
    await rename(found.path, this.pathIn(target, id))
  }

  /** Writes `<createState>/file-<n>.md` with the next free n (gaps reused),
   * or adopts the ticket carrying the same idempotency key. */
  async create(
    draft: TicketDraft,
    opts: TicketCreateOptions = {},
  ): Promise<Ticket> {
    await this.ensureLayout()
    const located = await this.scan()
    if (opts.idempotencyKey !== undefined) {
      const matches: Array<{ found: Located; front: Frontmatter; body: string }> = []
      for (const found of located) {
        const loaded = await this.loadAt(found)
        if (loaded.front.idempotencyKey === opts.idempotencyKey) {
          matches.push({ found, ...loaded })
        }
      }
      if (matches.length > 1) {
        throw new Error(
          `file ticket source: idempotency key "${opts.idempotencyKey}" exists on multiple tickets: ${matches.map((match) => match.found.id).join(', ')}`,
        )
      }
      const adopted = matches[0]
      if (adopted !== undefined) {
        return this.toTicket(adopted.front, adopted.body, adopted.found.state)
      }
    }
    const taken = new Set(located.map((f) => f.id))
    let n = 1
    while (taken.has(`file-${n}`)) n += 1
    const front: Frontmatter = {
      id: `file-${n}`,
      title: draft.title,
      labels: [...(draft.labels ?? [])],
      ...(draft.blockedBy !== undefined && draft.blockedBy.length > 0
        ? { blockedBy: [...draft.blockedBy] }
        : {}),
      ...(opts.idempotencyKey !== undefined
        ? { idempotencyKey: opts.idempotencyKey }
        : {}),
    }
    const targetState =
      opts.state === undefined ? this.createState : stateDir(opts.state)
    await writeFile(
      this.pathIn(targetState, front.id),
      serializeTicketFile(front, draft.body),
    )
    return this.toTicket(front, draft.body, targetState)
  }

  /**
   * Dependency nodes (§13). Resolution is this source's own lifecycle, and
   * this source's lifecycle is the filesystem: a blocker is complete when its
   * file sits in the done directory. Nothing is read from the frontmatter to
   * decide it — there is no `state` field to disagree with the directory.
   *
   * An id that cannot name a file (path traversal) is reported as
   * `exists: false` rather than thrown: a bad reference is a missing
   * dependency, and one ticket's typo must not abort the whole tick. A
   * *malformed* file still throws — that is operator error about a real
   * ticket, and the dispatcher confines the blast radius to the one ticket
   * that referenced it.
   */
  async dependencyStates(ids: string[]): Promise<DependencyState[]> {
    const states: DependencyState[] = []
    for (const id of ids) {
      let found: Located | null
      try {
        found = await this.locate(id)
      } catch (error) {
        if (error instanceof Error && error.message.includes('invalid ticket id')) {
          states.push({ id, exists: false, resolved: false, blockedBy: [] })
          continue
        }
        throw error
      }
      if (found === null) {
        states.push({ id, exists: false, resolved: false, blockedBy: [] })
        continue
      }
      const loaded = await this.loadAt(found)
      states.push({
        id,
        exists: true,
        resolved: found.state === this.doneState,
        blockedBy: [...(loaded.front.blockedBy ?? [])],
      })
    }
    return states
  }

  /**
   * The four state dirs, plus — for the defaulted backlog only — a
   * self-excluding `.gitignore`. Same move `src/cli/context.ts` makes for
   * `.ab/`: the dir hides itself from git in ANY repo, so the local backlog is
   * never staged, without mutating the repo's own tracked `.gitignore` as an
   * unreviewed side effect. Idempotent; called at the head of every write.
   */
  private async ensureLayout(): Promise<void> {
    for (const state of TICKET_STATES) {
      await mkdir(join(this.dir, dirName(state)), { recursive: true })
    }
    if (this.selfIgnore) await writeFile(join(this.dir, '.gitignore'), '*\n')
  }

  private pathIn(state: TicketState, id: string): string {
    return join(this.dir, dirName(state), `${this.safeId(id)}.md`)
  }

  private safeId(id: string): string {
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new Error(`file ticket source: invalid ticket id "${id}"`)
    }
    return id
  }

  /** Find the one state dir holding `<id>.md`; null when absent. */
  private async locate(id: string): Promise<Located | null> {
    this.safeId(id)
    const hits: Located[] = []
    for (const state of TICKET_STATES) {
      const path = this.pathIn(state, id)
      try {
        await stat(path)
        hits.push({ id, state, path })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (hits.length > 1) throw duplicateError(id, hits.map((h) => h.path))
    return hits[0] ?? null
  }

  /** Every ticket file across the four state dirs, sorted, duplicates rejected. */
  private async scan(): Promise<Located[]> {
    await this.assertNoLooseTickets()
    const byId = new Map<string, Located[]>()
    for (const state of TICKET_STATES) {
      for (const entry of await this.readMarkdown(join(this.dir, dirName(state)))) {
        const id = entry.slice(0, -'.md'.length)
        const located = { id, state, path: join(this.dir, dirName(state), entry) }
        byId.set(id, [...(byId.get(id) ?? []), located])
      }
    }
    for (const [id, hits] of byId) {
      if (hits.length > 1) throw duplicateError(id, hits.map((h) => h.path))
    }
    return [...byId.values()].flat().sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * A `.md` at the tracker root has no state — it is invisible to every scan
   * and would never dispatch. Name it rather than ignore it.
   */
  private async assertNoLooseTickets(): Promise<void> {
    for (const entry of await this.readMarkdown(this.dir)) {
      throw new Error(
        `${join(this.dir, entry)}: ticket file outside a state directory — a ticket's ` +
          `state is the directory it sits in; move it into one of: ` +
          `${TICKET_STATES.map(dirName).join('/, ')}/`,
      )
    }
  }

  private async readMarkdown(path: string): Promise<string[]> {
    try {
      return (await readdir(path)).filter((e) => e.endsWith('.md')).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async loadAt(found: Located): Promise<{ front: Frontmatter; body: string }> {
    const loaded = parseTicketFile(found.path, await readFile(found.path, 'utf8'))
    if (loaded.front.id !== found.id) {
      throw new Error(
        `${found.path}: frontmatter id "${loaded.front.id}" does not match filename`,
      )
    }
    return loaded
  }

  private async listAll(): Promise<Ticket[]> {
    const tickets: Ticket[] = []
    for (const found of await this.scan()) {
      const loaded = await this.loadAt(found)
      tickets.push(this.toTicket(loaded.front, loaded.body, found.state))
    }
    return tickets
  }

  private toTicket(front: Frontmatter, body: string, state: TicketState): Ticket {
    return {
      ref: { source: this.name, id: front.id, title: front.title },
      title: front.title,
      body,
      state,
      labels: [...front.labels],
      ...(front.blockedBy !== undefined && front.blockedBy.length > 0
        ? { blockedBy: [...front.blockedBy] }
        : {}),
    }
  }
}

function duplicateError(id: string, paths: string[]): Error {
  return new Error(
    `file ticket source: ticket "${id}" exists in more than one state directory: ` +
      `${paths.join(', ')} — a ticket's state is the directory it sits in; keep ` +
      `exactly one copy (use mv, not cp)`,
  )
}
