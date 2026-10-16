import { fileRequestedIds, validateFileTicketId } from './requested-id'
import { FileTicketAssets } from './file-assets'
/**
 * File-based TicketSource (SPEC §3.2, §13): the default tracker. A directory
 * of state directories — the lifecycle four `triage/ ready/ doing/ done/`
 * plus any the repository adds, such as `icebox/` — each holding
 * `<id>.md` files: TOML frontmatter between `+++` fences, then the ticket
 * body, where the spec lives pre-build (§6.3). This adapter is the policy's
 * proof: a source with nowhere to put blobs must be fully workable, because
 * the tracker initiates and receives projections only — never consulted
 * mid-build, never artifact storage.
 *
 * A ticket's state IS the directory it sits in. There is no `state` field to
 * disagree with the filesystem, and `transition` and `claim` are rename(2).
 * Moving a valid record from `triage/` to `ready/` is the complete
 * lifecycle-state grooming UX; listing validates every candidate before it can
 * become eligible.
 *
 * Concurrency: writes locate and validate immediately before a same-path
 * rewrite or same-filesystem rename; there is no filesystem lock. The
 * dispatcher remains the lifecycle single writer (SPEC §12), and concurrent
 * unguarded human edits are explicitly last-write-wins. Revision-checked writes
 * compare the final read, retaining the same unlocked read/write race window. State renames never cross a
 * filesystem: `<dir>/ready` → `<dir>/doing` is one mount by construction.
 */
import {
  STATE_NAME_RULE,
  validateStateName,
  validateStatePurpose,
  orderStates,
  resolveState,
} from './states'
import { readdirSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseTicketFile,
  serializeTicketFile,
  TicketFileValidationError,
  type Frontmatter,
} from './file-codec'
export { TicketFileValidationError } from './file-codec'
import { ticketRevision, checkTicketRevision } from './revision'
import { systemClock, type Clock } from '../../store/types'
import type {
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketListing,
  TicketSource,
  TicketStateInfo,
  TicketUpdate,
  TicketMutation,
} from '../types'
import { validateTicketUpdate } from './update'

/** Repo-relative fallback when no selected local-state root is supplied. */
export const DEFAULT_TICKETS_DIR = '.autobuild/tickets'

/**
 * The directories the dispatcher's roles (create, ready, claim, triage, done)
 * are played by. Always valid state names, because `ensureLayout` creates them.
 */
const LIFECYCLE_DIRS = ['triage', 'ready', 'doing', 'done'] as const

/** Dotfile inside a state directory holding its one-line purpose. Dot entries
 * and non-`.md` files are never tickets, so it can never be mistaken for one. */
const ABOUT_FILE = '.about'

export { validateStateName } from './states'

function statesIn(directories: string[]): string[] {
  return orderStates(
    [
      ...new Set([
        ...LIFECYCLE_DIRS.filter(
          (name) => !directories.some((dir) => dir.toLowerCase() === name && dir !== name),
        ),
        ...directories.filter((name) => !name.startsWith('.')),
      ]),
    ],
    LIFECYCLE_DIRS,
  )
}

/** A ticket file found on disk: its id, its state (= its directory), its path. */
interface Located {
  id: string
  state: string
  path: string
}

export class FileTicketSource implements TicketSource {
  readonly name = 'file'
  readonly requestedIds = fileRequestedIds
  readonly assets: FileTicketAssets

  private readonly dir: string
  private readonly clock: Clock
  private readonly createState: string
  private readonly doneState: string
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
     * local-state `tickets/` backlog (see createTicketSource): an explicitly
     * configured dir is the user's directory, and ab does not decide git's
     * view of it.
     */
    selfIgnore?: boolean
  }) {
    this.assets = new FileTicketAssets(opts.dir, async (id) => {
      const found = await this.locate(id)
      if (!found)
        return {
          exists: false,
          front: { id, title: id, labels: [] },
          save: async () => {
            throw new Error(`file ticket source: asset on unknown ticket "${id}"`)
          },
        }
      const loaded = { found, ...(await this.loadAt(found)) }
      return {
        ...loaded,
        save: (front: Frontmatter) => this.rewriteAt(loaded.found, front, loaded.body),
      }
    })
    this.dir = opts.dir
    this.clock = opts.clock ?? systemClock
    const existing = this.statesSync()
    this.createState = resolveState(opts.createState ?? 'Triage', existing)
    this.doneState = resolveState(opts.doneState ?? 'Done', existing)
    this.selfIgnore = opts.selfIgnore ?? false
  }

  async listReady(criteria: {
    labels?: string[]
    state?: string
    assignee?: string
  }): Promise<TicketListing> {
    const labels = criteria.labels ?? []
    const state =
      criteria.state === undefined ? undefined : resolveState(criteria.state, await this.states())
    // Through listAll, not a single readdir: scan completes its layout and
    // duplicate-id checks before any per-record validation is contained. A
    // malformed record can never weaken the invariant preventing a `cp`
    // between state dirs from becoming a silent double-dispatch.
    const listing = await this.listAll()
    return {
      tickets: listing.tickets.filter(
        (ticket) =>
          (state === undefined || ticket.state === state) &&
          labels.every((label) => ticket.labels.includes(label)),
      ),
      diagnostics: listing.diagnostics,
    }
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
   * The guard refuses a ticket already in doing or in this source's configured
   * terminal state rather than requiring one in ready. That inversion is
   * deliberate: a legal `[tickets] readyState = "Triage"` would otherwise
   * stall forever. Other nonterminal states remain claimable after an explicit
   * handback, while terminal work can never be reopened by claim.
   */
  async claim(id: string): Promise<boolean> {
    await this.ensureLayout()
    const found = await this.locate(id)
    if (found === null) return false
    // Revalidate at the targeted operation boundary, even when lifecycle state
    // will make the claim a no-op. Besides keeping malformed records loud,
    // this closes the list→claim window where a human could corrupt a record
    // after it was listed but before the dispatcher claims it.
    await this.loadAt(found)
    if (found.state === 'doing' || found.state === this.doneState) return false
    await rename(found.path, this.pathIn('doing', id))
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
    const parsed = parseTicketFile(found.path, raw)
    if (parsed.front.comments !== undefined) {
      parsed.front.comments.push({ body, createdAt: this.clock().toISOString() })
      await this.rewriteAt(found, parsed.front, parsed.body)
      return
    }
    const separator = raw.endsWith('\n') ? '\n' : '\n\n'
    const stamp = this.clock().toISOString()
    await writeFile(found.path, `${raw}${separator}## Comment (${stamp})\n\n${body}\n`)
  }

  /** A move, never a rewrite — which is why the body survives byte-exactly. */
  async transition(id: string, state: string): Promise<void> {
    await this.ensureLayout()
    const target = resolveState(state, await this.states())
    const found = await this.locate(id)
    if (found === null) {
      throw new Error(`file ticket source: transition on unknown ticket "${id}"`)
    }
    // Targeted writes remain loud for malformed records, including an
    // otherwise-idempotent transition to the current state.
    await this.loadAt(found)
    // Idempotent by construction — the dispatcher retries transitions after a
    // crash (file.test.ts explains the window). rename(2) would no-op here
    // anyway, but resting idempotency on that POSIX subtlety would make it a
    // property of the syscall rather than of this adapter.
    if (found.state === target) return
    await rename(found.path, this.pathIn(target, id))
  }

  /** Writes `<createState>/file-<n>.md` with the next free n (gaps reused),
   * or adopts the ticket carrying the same idempotency key. */
  async create(draft: TicketDraft, opts: TicketCreateOptions = {}): Promise<Ticket> {
    if (opts.requestedId !== undefined) validateFileTicketId(opts.requestedId)
    await this.ensureLayout()
    // Resolve before anything is read or written: an unknown state touches no file.
    const targetState =
      opts.state === undefined ? this.createState : resolveState(opts.state, await this.states())
    const located = await this.scan()
    if (opts.idempotencyKey !== undefined) {
      const matches: Array<{
        found: Located
        front: Frontmatter
        body: string
      }> = []
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
      id: opts.requestedId ?? `file-${n}`,
      comments: [],
      title: draft.title,
      labels: [...(draft.labels ?? [])],
      ...(draft.blockedBy !== undefined && draft.blockedBy.length > 0
        ? { blockedBy: [...draft.blockedBy] }
        : {}),
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
    }
    if (taken.has(front.id)) throw new Error(`requested ticket id already occupied: ${front.id}`)
    await writeFile(this.pathIn(targetState, front.id), serializeTicketFile(front, draft.body), {
      flag: 'wx',
    })
    return this.toTicket(front, draft.body, targetState)
  }

  async mutateIfRevision(id: string, expected: string, mutation: TicketMutation): Promise<void> {
    const patch = mutation.kind === 'update' ? validateTicketUpdate(mutation.patch) : undefined
    await this.ensureLayout()
    const target =
      mutation.kind === 'transition' ? resolveState(mutation.state, await this.states()) : undefined
    if (mutation.kind === 'blockers') {
      for (const blocker of new Set(mutation.ids)) {
        if (mutation.operation === 'block' && blocker === id)
          throw new Error(`ticket "${id}" cannot block itself`)
        await this.requireForWrite(blocker, 'blocker')
      }
    }
    // Final locate/read immediately precedes the write. This is best effort,
    // matching unguarded file writes; it does not introduce filesystem locks.
    const loaded = await this.requireForWrite(id, 'revision-checked write')
    checkTicketRevision(this.toTicket(loaded.front, loaded.body, loaded.found.state), expected)
    if (target !== undefined) {
      if (loaded.found.state !== target) await rename(loaded.found.path, this.pathIn(target, id))
      return
    }
    const front = { ...loaded.front }
    let body = loaded.body
    if (patch) {
      if (patch.title !== undefined) front.title = patch.title
      if (patch.labels !== undefined) front.labels = patch.labels
      if (patch.body !== undefined) body = patch.body
    } else if (mutation.kind === 'blockers') {
      const blockers = new Set(front.blockedBy ?? [])
      for (const blocker of mutation.ids) {
        if (mutation.operation === 'block') blockers.add(blocker)
        else blockers.delete(blocker)
      }
      front.blockedBy = [...blockers]
    }
    await this.rewriteAt(loaded.found, front, body)
  }

  async update(id: string, patch: TicketUpdate): Promise<void> {
    const validated = validateTicketUpdate(patch)
    await this.ensureLayout()
    const loaded = await this.requireForWrite(id, 'update')
    const front: Frontmatter = {
      ...loaded.front,
      ...(validated.title !== undefined ? { title: validated.title } : {}),
      ...(validated.labels !== undefined ? { labels: [...validated.labels] } : {}),
    }
    await this.rewriteAt(loaded.found, front, validated.body ?? loaded.body)
  }

  async addBlocker(id: string, blockerId: string): Promise<void> {
    await this.ensureLayout()
    const loaded = await this.requireForWrite(id, 'addBlocker')
    if (id === blockerId) {
      throw new Error(`file ticket source: ticket "${id}" cannot block itself`)
    }

    const blocker = await this.locate(blockerId)
    if (blocker === null) {
      throw new Error(
        `file ticket source: addBlocker on ticket "${id}" names unknown blocker "${blockerId}"`,
      )
    }
    await this.loadAt(blocker) // Existence means a valid ticket, not only a path.

    if (loaded.front.blockedBy?.includes(blockerId)) return
    await this.rewriteAt(
      loaded.found,
      {
        ...loaded.front,
        blockedBy: [...(loaded.front.blockedBy ?? []), blockerId],
      },
      loaded.body,
    )
  }

  async removeBlocker(id: string, blockerId: string): Promise<void> {
    await this.ensureLayout()
    const loaded = await this.requireForWrite(id, 'removeBlocker')
    const remaining = (loaded.front.blockedBy ?? []).filter((candidate) => candidate !== blockerId)
    if (remaining.length === (loaded.front.blockedBy ?? []).length) return

    const front: Frontmatter = { ...loaded.front }
    if (remaining.length === 0) delete front.blockedBy
    else front.blockedBy = remaining
    await this.rewriteAt(loaded.found, front, loaded.body)
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

  /** Every state with its ticket count and purpose. Reads directories only —
   * never parses a ticket — so a malformed record cannot hide the states. */
  async listStates(): Promise<TicketStateInfo[]> {
    const infos: TicketStateInfo[] = []
    for (const name of await this.states()) infos.push(await this.stateInfo(name))
    return infos
  }

  async addState(
    name: string,
    opts: { about?: string } = {},
  ): Promise<{ state: TicketStateInfo; created: boolean }> {
    validateStateName(name)
    const about = validateStatePurpose(opts.about)
    const existing = await this.states()
    const clash = existing.find((s) => s !== name && s.toLowerCase() === name.toLowerCase())
    if (clash !== undefined) {
      throw new Error(
        `file ticket source: state "${name}" collides with the existing state "${clash}" — ${STATE_NAME_RULE}, ` +
          'and state names are compared case-insensitively',
      )
    }
    const created = !existing.includes(name)
    await this.ensureLayout()
    if (created) await mkdir(join(this.dir, name))
    if (about !== undefined) await writeFile(join(this.dir, name, ABOUT_FILE), `${about}\n`)
    return { state: await this.stateInfo(name), created }
  }

  private async stateInfo(name: string): Promise<TicketStateInfo> {
    const tickets = (await this.readMarkdown(join(this.dir, name))).length
    let about: string | undefined
    try {
      about = (await readFile(join(this.dir, name, ABOUT_FILE), 'utf8')).trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { name, tickets, ...(about ? { about } : {}) }
  }

  /**
   * The four lifecycle dirs (never a custom state: `addState` is the
   * explicit act), plus — for the defaulted backlog only — a
   * self-excluding `.gitignore`. Same move `src/cli/context.ts` makes for
   * `.ab/`: the dir hides itself from git in ANY repo, so the local backlog is
   * never staged, without mutating the repo's own tracked `.gitignore` as an
   * unreviewed side effect. Idempotent; called at the head of every write.
   */
  private async ensureLayout(): Promise<void> {
    for (const state of LIFECYCLE_DIRS) {
      await mkdir(join(this.dir, state), { recursive: true })
    }
    if (this.selfIgnore) await writeFile(join(this.dir, '.gitignore'), '*\n')
  }

  /** The state names that exist now. Re-read per operation so a directory
   * created while a long-running dispatcher is up is seen. */
  private async states(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true })
      const directories: string[] = []
      for (const entry of entries) {
        if (entry.isDirectory()) directories.push(entry.name)
        else if (entry.isSymbolicLink()) {
          const target = await stat(join(this.dir, entry.name)).catch(() => null)
          if (target?.isDirectory()) directories.push(entry.name)
        }
      }
      return statesIn(directories)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return statesIn([])
      throw error
    }
  }

  /** Constructor-time twin of `states()`: the only sync IO in this adapter. */
  private statesSync(): string[] {
    try {
      const entries = readdirSync(this.dir, { withFileTypes: true })
      const directories = entries
        .filter(
          (e) =>
            e.isDirectory() ||
            (e.isSymbolicLink() &&
              statSync(join(this.dir, e.name), { throwIfNoEntry: false })?.isDirectory()),
        )
        .map((e) => e.name)
      return statesIn(directories)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return statesIn([])
      throw error
    }
  }

  private pathIn(state: string, id: string): string {
    return join(this.dir, state, `${this.safeId(id)}.md`)
  }

  private safeId(id: string): string {
    return validateFileTicketId(id)
  }

  /** Find the one state dir holding `<id>.md`; null when absent. */
  private async locate(id: string): Promise<Located | null> {
    this.safeId(id)
    const hits: Located[] = []
    for (const state of await this.states()) {
      const path = this.pathIn(state, id)
      try {
        await stat(path)
        hits.push({ id, state, path })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (hits.length > 1)
      throw duplicateError(
        id,
        hits.map((h) => h.path),
      )
    return hits[0] ?? null
  }

  /** Every ticket file across every state dir, sorted, duplicates rejected. */
  private async scan(): Promise<Located[]> {
    await this.assertNoLooseTickets()
    const byId = new Map<string, Located[]>()
    for (const state of await this.states()) {
      for (const entry of await this.readMarkdown(join(this.dir, state))) {
        const id = entry.slice(0, -'.md'.length)
        const located = { id, state, path: join(this.dir, state, entry) }
        byId.set(id, [...(byId.get(id) ?? []), located])
      }
    }
    for (const [id, hits] of byId) {
      if (hits.length > 1)
        throw duplicateError(
          id,
          hits.map((h) => h.path),
        )
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
          `${(await this.states()).join('/, ')}/`,
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
      throw new TicketFileValidationError(
        `${found.path}: frontmatter id "${loaded.front.id}" does not match filename`,
      )
    }
    return loaded
  }

  private async requireForWrite(
    id: string,
    operation: string,
  ): Promise<{ found: Located; front: Frontmatter; body: string }> {
    const found = await this.locate(id)
    if (found === null) {
      throw new Error(`file ticket source: ${operation} on unknown ticket "${id}"`)
    }
    return { found, ...(await this.loadAt(found)) }
  }

  /** Rewrite only the located file: editable writes can never move lifecycle
   * state because the existing state-directory path remains authoritative. */
  private async rewriteAt(found: Located, front: Frontmatter, body: string): Promise<void> {
    const temp = `${found.path}.${crypto.randomUUID()}.tmp`
    await writeFile(temp, serializeTicketFile(front, body))
    await rename(temp, found.path)
  }

  private async listAll(): Promise<TicketListing> {
    const tickets: Ticket[] = []
    const diagnostics: string[] = []
    // Complete discovery first. Structural failures (including duplicate ids)
    // therefore win even when one of the discovered records is also malformed.
    const located = await this.scan()
    for (const found of located) {
      try {
        const loaded = await this.loadAt(found)
        tickets.push(this.toTicket(loaded.front, loaded.body, found.state))
      } catch (error) {
        if (error instanceof TicketFileValidationError) {
          diagnostics.push(error.message)
          continue
        }
        throw error
      }
    }
    return { tickets, diagnostics }
  }

  private toTicket(front: Frontmatter, body: string, state: string): Ticket {
    return {
      revision: ticketRevision({
        title: front.title,
        body,
        labels: front.labels,
        state,
        blockedBy: front.blockedBy,
        ...(front.comments !== undefined ? { comments: front.comments } : {}),
        ...(front.attachments !== undefined ? { attachments: front.attachments } : {}),
      }),
      ref: { source: this.name, id: front.id, title: front.title },
      ...(front.idempotencyKey !== undefined ? { creationKey: front.idempotencyKey } : {}),
      ...(front.comments !== undefined ? { comments: structuredClone(front.comments) } : {}),
      title: front.title,
      body,
      state,
      resolved: state === this.doneState,
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
